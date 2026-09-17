// Tiny hand-rolled PDF writer for fixtures.
//
// We generate test PDFs at run time instead of committing binaries: a bug
// report usually describes a *shape* of file ("12 pages, produced by Scanner
// X, has a form"), and that shape is easier to express in code than to find a
// sample for. Keeping the repo binary-free also keeps diffs reviewable.
//
// It writes PDF 1.x with a real cross-reference table, which is all pdf.js and
// pdf-lib need. Nothing here is a general-purpose PDF library.

/**
 * @param {object} [opts]
 * @param {number} [opts.pages=3]       number of pages
 * @param {string} [opts.version='1.4'] value for the %PDF- header
 * @param {boolean} [opts.acroForm=false] add an (empty) /AcroForm to the catalog
 * @param {string} [opts.title]    Info /Title  — tests use it to prove we never report it
 * @param {string} [opts.author]   Info /Author — same
 * @param {string} [opts.producer] Info /Producer (software name: safe to report)
 * @param {string} [opts.creator]  Info /Creator  (software name: safe to report)
 * @returns {Buffer} raw PDF bytes
 */
function makePdf(opts = {}) {
  const pages = opts.pages ?? 3;
  const version = opts.version ?? '1.4';
  const objects = []; // 1-based: objects[i] is object number i+1

  const add = (body) => {
    objects.push(body);
    return objects.length;
  };

  const catalogNum = add(null); // placeholders, filled in once numbers are known
  const pagesNum = add(null);
  const fontNum = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const kids = [];
  for (let i = 1; i <= pages; i++) {
    const text = `BT /F1 24 Tf 20 100 Td (Page ${i}) Tj ET`;
    const contentNum = add(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    const pageNum = add(
      `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 200 200] ` +
      `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`
    );
    kids.push(`${pageNum} 0 R`);
  }

  const info = [];
  if (opts.title) info.push(`/Title (${esc(opts.title)})`);
  if (opts.author) info.push(`/Author (${esc(opts.author)})`);
  info.push(`/Producer (${esc(opts.producer ?? 'splitpdf-test-writer')})`);
  info.push(`/Creator (${esc(opts.creator ?? 'splitpdf playwright suite')})`);
  const infoNum = add(`<< ${info.join(' ')} >>`);

  objects[pagesNum - 1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  objects[catalogNum - 1] =
    `<< /Type /Catalog /Pages ${pagesNum} 0 R` +
    (opts.acroForm ? ' /AcroForm << /Fields [] >>' : '') +
    ' >>';

  let out = `%PDF-${version}\n`;
  const offsets = [];
  objects.forEach((body, idx) => {
    offsets.push(out.length);
    out += `${idx + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    out += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R /Info ${infoNum} 0 R >>\n`;
  out += `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(out, 'latin1');
}

/**
 * A file that looks like a PDF but whose body and xref are unusable: valid
 * header, a catalog pointing at an object that does not exist, a bogus
 * startxref. Optionally carries Info strings so tests can prove that the
 * error report describes the file without leaking /Title or /Author.
 * @param {{title?:string, author?:string, producer?:string, creator?:string}} [opts]
 */
function makeCorruptPdf(opts = {}) {
  const info = [];
  if (opts.title) info.push(`/Title (${esc(opts.title)})`);
  if (opts.author) info.push(`/Author (${esc(opts.author)})`);
  info.push(`/Producer (${esc(opts.producer ?? 'corrupt-fixture-writer')})`);
  info.push(`/Creator (${esc(opts.creator ?? 'splitpdf playwright suite')})`);
  return Buffer.from(
    '%PDF-1.4\n' +
    '1 0 obj\n<< /Type /Catalog /Pages 9 0 R >>\nendobj\n' +
    'this is not a pdf body at all -- garbage garbage garbage\n' +
    `2 0 obj\n<< ${info.join(' ')} >>\nendobj\n` +
    'trailer\n<< /Size 99 /Root 1 0 R /Info 2 0 R >>\nstartxref\n999999\n%%EOF\n',
    'latin1'
  );
}

function esc(s) {
  return String(s).replace(/([()\\])/g, '\\$1');
}

module.exports = { makePdf, makeCorruptPdf };
