const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

// ─── Body size config (Vercel) ────────────────────────────────────────────────
// Allows PDFs up to 10 MB to be sent as base64
module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

// ─── Utility helpers ──────────────────────────────────────────────────────────

function base64ToBuffer(base64str) {
  return Buffer.from(base64str, 'base64');
}

function bufferToBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

// ─── Core pdf-lib injection ───────────────────────────────────────────────────
//
// Coordinate system (matches Zite frontend field mappings):
//   pdfX / pdfY  →  from BOTTOM-LEFT of the page, in PDF points
//   pdfW / pdfH  →  width / height of the field box, in PDF points
//   page         →  1-indexed page number
//
// Field types supported:
//   "text"      →  draws text inside the field box
//   "checkbox"  →  true = green ✓, false = red ✗
//   "signature" →  embeds a PNG image (base64 data URL from the signature pad)
//
async function injectIntoPdf(pdfBase64, fields, values) {
  const pdfDoc = await PDFDocument.load(base64ToBuffer(pdfBase64));
  const font   = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages  = pdfDoc.getPages();

  // Build a fieldId → value lookup map for O(1) access
  const valueMap = {};
  for (const v of values) {
    valueMap[v.fieldId] = v;
  }

  for (const field of fields) {
    const page = pages[field.page - 1]; // convert 1-indexed → 0-indexed
    if (!page) continue;

    const val = valueMap[field.id];
    if (!val) continue; // no value provided for this field — skip

    const { pdfX: x, pdfY: y, pdfW: w, pdfH: h } = field;

    // Proportional margin and line thickness relative to field size
    const m         = Math.min(w, h) * 0.12;
    const thickness = Math.max(1, Math.min(2.5, h * 0.09));

    // ── TEXT ─────────────────────────────────────────────────────────────────
    if (field.type === 'text' && val.text && val.text.trim() !== '') {
      const fontSize = Math.min(11, Math.max(6, h * 0.55));
      page.drawText(String(val.text), {
        x        : x + 2,
        y        : y + (h - fontSize) / 2,   // vertically centred
        size     : fontSize,
        font,
        color    : rgb(0, 0, 0),
        maxWidth : w - 4,
      });
    }

    // ── CHECKBOX  (true = ✓  |  false = ✗) ───────────────────────────────────
    if (
      field.type === 'checkbox' &&
      val.checked !== undefined &&
      val.checked !== null
    ) {
      if (val.checked === true) {
        // Green checkmark — two line segments forming a tick
        page.drawLine({
          start     : { x: x + m,        y: y + h * 0.50 },
          end       : { x: x + w * 0.38, y: y + m        },
          thickness,
          color     : rgb(0, 0.55, 0.10),
        });
        page.drawLine({
          start     : { x: x + w * 0.38, y: y + m        },
          end       : { x: x + w - m,    y: y + h - m    },
          thickness,
          color     : rgb(0, 0.55, 0.10),
        });
      } else {
        // Red cross — two diagonal lines
        page.drawLine({
          start     : { x: x + m,     y: y + m     },
          end       : { x: x + w - m, y: y + h - m },
          thickness,
          color     : rgb(0.80, 0.05, 0.05),
        });
        page.drawLine({
          start     : { x: x + w - m, y: y + m     },
          end       : { x: x + m,     y: y + h - m },
          thickness,
          color     : rgb(0.80, 0.05, 0.05),
        });
      }
    }

    // ── SIGNATURE  (PNG data URL from canvas signature pad) ──────────────────
    if (field.type === 'signature' && val.signatureUrl) {
      try {
        const b64      = val.signatureUrl.replace(/^data:image\/png;base64,/, '');
        const imgBytes = base64ToBuffer(b64);
        const img      = await pdfDoc.embedPng(imgBytes);
        page.drawImage(img, {
          x,
          y,
          width  : w,
          height : h,
        });
      } catch (sigErr) {
        console.error(`[injectPdf] Failed to embed signature for field "${field.id}":`, sigErr.message);
        // Continue processing other fields even if one signature fails
      }
    }
  }

  const filledBytes = await pdfDoc.save();
  return bufferToBase64(filledBytes);
}

// ─── Vercel API route handler ─────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // CORS headers — required if you ever call this endpoint from a browser directly
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const { pdfBase64, fields, values } = req.body || {};

  // Validate required inputs
  if (!pdfBase64) {
    return res.status(400).json({ error: 'Missing required field: pdfBase64 (string)' });
  }
  if (!Array.isArray(fields)) {
    return res.status(400).json({ error: 'Missing required field: fields (array)' });
  }
  if (!Array.isArray(values)) {
    return res.status(400).json({ error: 'Missing required field: values (array)' });
  }

  try {
    const filledPdfBase64 = await injectIntoPdf(pdfBase64, fields, values);
    return res.status(200).json({ filledPdfBase64 });
  } catch (err) {
    console.error('[injectPdf] Injection error:', err);
    return res.status(500).json({
      error   : err.message || 'PDF injection failed',
      details : process.env.NODE_ENV === 'development' ? err.stack : undefined,
    });
  }
};
