import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { serviceClient } from './supabaseClients';
import { getInspectionDetail, type ReportStats } from './inspectionRepository';
import type { InspectionSummary } from './types';

/**
 * The audit pack.
 *
 * A CSV is for analysis. This is the artefact you hand to a Municipality
 * inspector or attach to a HACCP review: the numbers, the exceptions, and
 * the evidence photographs, in one file that cannot be edited in a
 * spreadsheet on the way there.
 *
 * Type is Helvetica. Healthy Sans is proprietary and embedding it here
 * would mean shipping the font files; a PDF is a document, not a screen,
 * so the brand carries through colour and layout instead.
 */

const BRAND_BOLD = rgb(0.067, 0.294, 0.204); // brand-90  #114B34
const BRAND = rgb(0.141, 0.631, 0.439); // brand-60  #24A170
const INK = rgb(0.204, 0.231, 0.259); // base-80   #343B42
const MUTED = rgb(0.412, 0.471, 0.525); // base-70   #697886
const LINE = rgb(0.867, 0.878, 0.894); // base-40   #DDE0E4
const FAIL = rgb(0.890, 0.314, 0.267); // error-3   #E35044
const HOLD = rgb(0.863, 0.408, 0.012); // warning-3 #DC6803

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 48;
const CONTENT_WIDTH = A4.width - MARGIN * 2;

type Fonts = { regular: PDFFont; bold: PDFFont };

type Cursor = { page: PDFPage; y: number };

export type PdfInput = {
  from: Date;
  to: Date;
  areaName: string;
  stats: ReportStats;
  records: InspectionSummary[];
  generatedBy: string;
};

const formatDate = (date: Date): string =>
  date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

/** Hard-wraps on width rather than character count, so long notes fit. */
const wrap = (text: string, font: PDFFont, size: number, maxWidth: number): string[] => {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current !== '') {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current !== '') {
    lines.push(current);
  }
  return lines;
};

const newPage = (doc: PDFDocument): Cursor => ({
  page: doc.addPage([A4.width, A4.height]),
  y: A4.height - MARGIN,
});

/** Adds a page when the next block will not fit, so nothing is clipped. */
const ensure = (doc: PDFDocument, cursor: Cursor, needed: number): Cursor =>
  cursor.y - needed < MARGIN + 30 ? newPage(doc) : cursor;

const drawHeader = (cursor: Cursor, fonts: Fonts, input: PdfInput): void => {
  const { page } = cursor;

  page.drawRectangle({
    x: 0,
    y: A4.height - 96,
    width: A4.width,
    height: 96,
    color: BRAND_BOLD,
  });

  page.drawRectangle({
    x: MARGIN,
    y: A4.height - 62,
    width: 24,
    height: 24,
    color: rgb(1, 1, 1),
  });
  page.drawText('C', {
    x: MARGIN + 8,
    y: A4.height - 55,
    size: 11,
    font: fonts.bold,
    color: BRAND,
  });
  page.drawText('CALO', {
    x: MARGIN + 34,
    y: A4.height - 55,
    size: 13,
    font: fonts.bold,
    color: rgb(1, 1, 1),
  });

  page.drawText('Van pre-departure inspection record', {
    x: MARGIN,
    y: A4.height - 84,
    size: 9,
    font: fonts.regular,
    color: rgb(0.8, 0.87, 0.84),
  });

  cursor.y = A4.height - 130;

  page.drawText(input.areaName, {
    x: MARGIN,
    y: cursor.y,
    size: 22,
    font: fonts.bold,
    color: INK,
  });

  cursor.y -= 18;
  page.drawText(`${formatDate(input.from)} to ${formatDate(input.to)}`, {
    x: MARGIN,
    y: cursor.y,
    size: 10,
    font: fonts.regular,
    color: MUTED,
  });

  cursor.y -= 26;
};

const drawStats = (cursor: Cursor, fonts: Fonts, stats: ReportStats): void => {
  const { page } = cursor;
  const boxWidth = (CONTENT_WIDTH - 24) / 4;

  const tiles: { label: string; value: string; note: string }[] = [
    {
      label: 'Vehicles checked',
      value: String(stats.vansCovered),
      note: `${stats.checks} inspection${stats.checks === 1 ? '' : 's'}`,
    },
    {
      label: 'Compliance',
      value: `${stats.compliancePct}%`,
      note: `${stats.cleared} of ${stats.checks} cleared`,
    },
    {
      label: 'Non-compliant',
      value: String(stats.nonCompliant),
      note: 'failures to close out',
    },
    {
      label: 'Highest temp',
      value: stats.worstTempC === null ? 'n/a' : `${stats.worstTempC.toFixed(1)} C`,
      note: 'Range 0 to 5 C',
    },
  ];

  tiles.forEach((tile, index) => {
    const x = MARGIN + index * (boxWidth + 8);
    page.drawRectangle({
      x,
      y: cursor.y - 58,
      width: boxWidth,
      height: 58,
      borderColor: LINE,
      borderWidth: 1,
      color: rgb(0.98, 0.98, 0.985),
    });
    page.drawText(tile.label.toUpperCase(), {
      x: x + 10,
      y: cursor.y - 18,
      size: 6.5,
      font: fonts.bold,
      color: MUTED,
    });
    page.drawText(tile.value, {
      x: x + 10,
      y: cursor.y - 40,
      size: 18,
      font: fonts.bold,
      color: INK,
    });
    page.drawText(tile.note, {
      x: x + 10,
      y: cursor.y - 51,
      size: 6.5,
      font: fonts.regular,
      color: MUTED,
    });
  });

  cursor.y -= 78;
};

const COLUMNS = [
  { title: 'Date', width: 62 },
  { title: 'Van', width: 72 },
  { title: 'Driver', width: 118 },
  { title: 'Temp', width: 44 },
  { title: 'Issues', width: 40 },
  { title: 'Status', width: 76 },
  { title: 'Inspector', width: 87 },
];

const drawTable = (
  doc: PDFDocument,
  cursorRef: Cursor,
  fonts: Fonts,
  records: InspectionSummary[],
): Cursor => {
  let cursor = ensure(doc, cursorRef, 60);

  cursor.page.drawText('Inspections', {
    x: MARGIN,
    y: cursor.y,
    size: 12,
    font: fonts.bold,
    color: INK,
  });
  cursor.y -= 18;

  const drawHeadings = (target: Cursor): void => {
    let x = MARGIN;
    for (const column of COLUMNS) {
      target.page.drawText(column.title.toUpperCase(), {
        x,
        y: target.y,
        size: 6.5,
        font: fonts.bold,
        color: MUTED,
      });
      x += column.width;
    }
    target.y -= 6;
    target.page.drawLine({
      start: { x: MARGIN, y: target.y },
      end: { x: MARGIN + CONTENT_WIDTH, y: target.y },
      thickness: 0.75,
      color: LINE,
    });
    target.y -= 12;
  };

  drawHeadings(cursor);

  for (const record of records) {
    if (cursor.y < MARGIN + 40) {
      cursor = newPage(doc);
      drawHeadings(cursor);
    }

    const when = new Date(record.performedAt);
    const statusLabel = record.status === 'compliant' ? 'Cleared' : 'Non-compliant';
    const statusColour = record.status === 'compliant' ? BRAND : FAIL;

    const cells: { text: string; colour: ReturnType<typeof rgb>; bold?: boolean }[] = [
      { text: when.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }), colour: MUTED },
      { text: record.plate, colour: INK, bold: true },
      { text: record.driverName.slice(0, 24), colour: INK },
      {
        text: record.tempReadingC === null ? '-' : `${record.tempReadingC.toFixed(1)}`,
        colour: record.tempReadingC !== null && record.tempReadingC > 5 ? FAIL : INK,
      },
      { text: record.failedCount === 0 ? '-' : String(record.failedCount), colour: INK },
      { text: statusLabel, colour: statusColour, bold: true },
      { text: record.inspectorName.slice(0, 18), colour: MUTED },
    ];

    let x = MARGIN;
    cells.forEach((cell, index) => {
      cursor.page.drawText(cell.text, {
        x,
        y: cursor.y,
        size: 8,
        font: cell.bold === true ? fonts.bold : fonts.regular,
        color: cell.colour,
      });
      x += COLUMNS[index]?.width ?? 0;
    });

    cursor.y -= 15;
  }

  return cursor;
};

type EmbeddedPhoto = { bytes: Uint8Array; isPng: boolean };

const fetchPhoto = async (storageKey: string): Promise<EmbeddedPhoto | null> => {
  const { data, error } = await serviceClient().storage
    .from('inspection-photos')
    .download(storageKey);

  if (error !== null || data === null) {
    return null;
  }

  const bytes = new Uint8Array(await data.arrayBuffer());
  // Browser compression writes JPEG, but older records may be PNG. Check
  // the magic bytes rather than trusting the extension.
  const isPng =
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  return { bytes, isPng };
};

const drawEvidence = async (
  doc: PDFDocument,
  cursorRef: Cursor,
  fonts: Fonts,
  records: InspectionSummary[],
): Promise<void> => {
  const failed = records.filter((record) => record.failedCount > 0);
  if (failed.length === 0) {
    return;
  }

  let cursor = newPage(doc);
  cursor.page.drawText('Evidence', {
    x: MARGIN,
    y: cursor.y,
    size: 14,
    font: fonts.bold,
    color: INK,
  });
  cursor.y -= 12;
  cursor.page.drawText('Photographs recorded at the point of inspection.', {
    x: MARGIN,
    y: cursor.y,
    size: 8,
    font: fonts.regular,
    color: MUTED,
  });
  cursor.y -= 24;

  for (const record of failed) {
    const detail = await getInspectionDetail(record.id);
    if (detail === null) {
      continue;
    }

    cursor = ensure(doc, cursor, 40);
    cursor.page.drawText(`${record.plate}  ·  ${record.driverName}`, {
      x: MARGIN,
      y: cursor.y,
      size: 10,
      font: fonts.bold,
      color: INK,
    });
    cursor.y -= 12;
    cursor.page.drawText(
      `${new Date(record.performedAt).toLocaleString('en-GB')}  ·  ${detail.inspectorName}`,
      { x: MARGIN, y: cursor.y, size: 7.5, font: fonts.regular, color: MUTED },
    );
    cursor.y -= 16;

    for (const failure of detail.failures) {
      cursor = ensure(doc, cursor, 30);

      cursor.page.drawText(
        `${failure.label}${failure.causeLabel === null ? '' : `: ${failure.causeLabel}`}${failure.critical ? '  (blocked dispatch)' : ''}`,
        {
          x: MARGIN,
          y: cursor.y,
          size: 9,
          font: fonts.bold,
          color: failure.critical ? HOLD : FAIL,
        },
      );
      cursor.y -= 12;

      if (failure.actionLabel !== null) {
        cursor = ensure(doc, cursor, 12);
        cursor.page.drawText(`Action: ${failure.actionLabel}`, {
          x: MARGIN,
          y: cursor.y,
          size: 8,
          font: fonts.bold,
          color: MUTED,
        });
        cursor.y -= 11;
      }

      if (failure.note !== null && failure.note !== '') {
        for (const line of wrap(failure.note, fonts.regular, 8, CONTENT_WIDTH)) {
          cursor = ensure(doc, cursor, 12);
          cursor.page.drawText(line, {
            x: MARGIN,
            y: cursor.y,
            size: 8,
            font: fonts.regular,
            color: INK,
          });
          cursor.y -= 11;
        }
      }

      for (const key of failure.photoKeys) {
        const photo = await fetchPhoto(key);
        if (photo === null) {
          continue;
        }

        try {
          const image = photo.isPng
            ? await doc.embedPng(photo.bytes)
            : await doc.embedJpg(photo.bytes);

          const maxWidth = 220;
          const scale = Math.min(maxWidth / image.width, 1);
          const width = image.width * scale;
          const height = image.height * scale;

          cursor = ensure(doc, cursor, height + 14);
          cursor.page.drawImage(image, {
            x: MARGIN,
            y: cursor.y - height,
            width,
            height,
          });
          cursor.y -= height + 12;
        } catch {
          // A single unreadable image must not lose the whole pack.
          cursor.page.drawText('[photo could not be embedded]', {
            x: MARGIN,
            y: cursor.y,
            size: 7.5,
            font: fonts.regular,
            color: MUTED,
          });
          cursor.y -= 12;
        }
      }

      cursor.y -= 6;
    }

    if (detail.notes !== null && detail.notes !== '') {
      cursor = ensure(doc, cursor, 24);
      cursor.page.drawText('Inspector notes', {
        x: MARGIN,
        y: cursor.y,
        size: 7.5,
        font: fonts.bold,
        color: MUTED,
      });
      cursor.y -= 11;
      for (const line of wrap(detail.notes, fonts.regular, 8, CONTENT_WIDTH)) {
        cursor = ensure(doc, cursor, 12);
        cursor.page.drawText(line, {
          x: MARGIN,
          y: cursor.y,
          size: 8,
          font: fonts.regular,
          color: INK,
        });
        cursor.y -= 11;
      }
    }

    cursor.y -= 14;
  }
};

const drawFooters = (doc: PDFDocument, fonts: Fonts, generatedBy: string): void => {
  const pages = doc.getPages();
  const stamp = new Date().toLocaleString('en-GB');

  pages.forEach((page, index) => {
    // Provenance on every page: a single page photocopied out of the pack
    // still says where it came from and when.
    page.drawText(
      `Calo UAE van inspection record  ·  generated ${stamp} by ${generatedBy}  ·  records are immutable once filed`,
      { x: MARGIN, y: 26, size: 6.5, font: fonts.regular, color: MUTED },
    );
    page.drawText(`${index + 1} of ${pages.length}`, {
      x: A4.width - MARGIN - 40,
      y: 26,
      size: 6.5,
      font: fonts.bold,
      color: MUTED,
    });
  });
};

export const buildInspectionPdf = async (input: PdfInput): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();

  doc.setTitle(`Calo van inspections ${input.areaName}`);
  doc.setAuthor('Calo UAE');
  doc.setSubject('Pre-departure quality inspection record');
  doc.setProducer('Calo Van Check');

  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };

  const cursor = newPage(doc);
  drawHeader(cursor, fonts, input);
  drawStats(cursor, fonts, input.stats);

  const afterTable = drawTable(doc, cursor, fonts, input.records);
  await drawEvidence(doc, afterTable, fonts, input.records);
  drawFooters(doc, fonts, input.generatedBy);

  return doc.save();
};
