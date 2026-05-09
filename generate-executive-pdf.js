#!/usr/bin/env node
// Render a standalone executive HTML to a 5-page Letter-size PDF.
// Usage: node generate-executive-pdf.js <input.html> <output.pdf>
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

async function main() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath) {
    console.error('Usage: node generate-executive-pdf.js <input.html> <output.pdf>');
    process.exit(1);
  }
  if (!fs.existsSync(inputPath)) {
    console.error(`Input HTML not found: ${inputPath}`);
    process.exit(1);
  }

  const launchArgs = process.env.PUPPETEER_NO_SANDBOX === '1'
    ? ['--no-sandbox', '--disable-setuid-sandbox']
    : [];
  const browser = await puppeteer.launch({ headless: 'new', args: launchArgs });
  try {
    const page = await browser.newPage();
    const fileUrl = 'file://' + path.resolve(inputPath);
    await page.goto(fileUrl, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: outputPath,
      format: 'Letter',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0in', right: '0in', bottom: '0in', left: '0in' },
    });
    console.log(`Rendered: ${outputPath}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
