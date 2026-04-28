#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { marked } = require('marked');
const puppeteer = require('puppeteer');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const config = require('./config');

marked.setOptions({
  breaks: false,
  gfm: true,
  headerIds: false,
  mangle: false,
});

async function main() {
  const practiceSlug = process.argv[2];
  if (!practiceSlug) {
    console.error('Usage: node generate-pdf.js [practicename]');
    process.exit(1);
  }

  const cwd = process.cwd();
  const markdownPath = path.join(
    cwd,
    config.paths.markdownDir,
    `${practiceSlug}_clarity_diagnostic.md`
  );
  const screenshotsDir = path.join(cwd, config.paths.screenshotsDir);
  const deliverablesDir = path.join(cwd, config.paths.deliverablesDir);
  const outputPath = path.join(
    deliverablesDir,
    `${practiceSlug}_clarity_diagnostic.pdf`
  );
  const logoPath = path.join(__dirname, config.paths.logo);
  const templatePath = path.join(__dirname, config.paths.template);

  if (!fs.existsSync(markdownPath)) {
    console.error(`Markdown file not found. Expected: ${markdownPath}`);
    process.exit(1);
  }

  fs.mkdirSync(deliverablesDir, { recursive: true });

  const markdown = fs.readFileSync(markdownPath, 'utf8');
  const documentData = parseDiagnostic(markdown, practiceSlug);
  const screenshotState = collectScreenshots(documentData.findings, screenshotsDir);
  const html = buildHtml({
    documentData,
    screenshotState,
    logoPath,
    templatePath,
  });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clarity-render-'));
  const htmlPath = path.join(tempDir, `${practiceSlug}.html`);
  const rawPdfPath = path.join(tempDir, `${practiceSlug}.raw.pdf`);
  fs.writeFileSync(htmlPath, html, 'utf8');

  await renderPdf(htmlPath, rawPdfPath);
  await stampFooter({
    inputPath: rawPdfPath,
    outputPath,
    practiceName: documentData.practiceName,
    logoPath,
  });

  console.log(`Rendered PDF: ${outputPath}`);
  if (screenshotState.missing.length > 0) {
    console.warn('\nMissing screenshots:');
    for (const missing of screenshotState.missing) {
      console.warn(`- ${missing}`);
    }
  }
}

function parseDiagnostic(markdown, practiceSlug) {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const cleanLines = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed !== '[COVER PAGE]'
      && trimmed !== '*[Page 2]*'
      && !/^#{1,6}\s+\[.*\]\s*$/.test(trimmed);
  });
  const text = cleanLines.join('\n');

  const section30 = text.indexOf('## The 30-Second Read');
  const sectionHow = text.indexOf('## How I See This');
  const sectionFindings = text.indexOf('## The Findings');
  const sectionOther = text.indexOf('## Other Things I Noticed');
  const sectionSequence = text.indexOf("## How I'd Sequence the Fixes");
  const sectionNext = text.indexOf('## The Next Step');

  const coverChunk = text.slice(0, section30 >= 0 ? section30 : text.length).trim();
  const coverInfo = parseCover(coverChunk, practiceSlug);

  const openerStart = coverInfo.coverBodyEndOffset || 0;
  const openerChunk = coverChunk.slice(openerStart).trim();

  const summaryChunk = sliceSection(text, section30, sectionHow, '## The 30-Second Read');
  const howChunk = sliceSection(text, sectionHow, sectionFindings, '## How I See This');
  const findingsChunk = sliceSection(text, sectionFindings, sectionOther, '## The Findings');
  const otherChunk = sliceSection(text, sectionOther, sectionSequence, '## Other Things I Noticed');
  const sequenceChunk = sliceSection(text, sectionSequence, sectionNext, "## How I'd Sequence the Fixes");
  const nextChunk = sliceSection(text, sectionNext, text.length, '## The Next Step');

  const findings = parseFindings(findingsChunk);
  const otherItems = parseOtherItems(otherChunk);
  const sequence = parseSequence(sequenceChunk);
  const nextStep = parseNextStep(nextChunk);

  return {
    title: coverInfo.title,
    subtitle: coverInfo.subtitle,
    practiceName: coverInfo.practiceName,
    preparedByLine: coverInfo.preparedByLine,
    opener: normalizeBlankLines(openerChunk),
    summary: normalizeBlankLines(summaryChunk),
    perspective: normalizeBlankLines(howChunk),
    findings,
    otherItems,
    sequence,
    nextStep,
  };
}

function parseCover(chunk, practiceSlug) {
  const lines = chunk.split('\n').map((line) => line.trim()).filter(Boolean);
  const headingCandidates = lines.filter((line) => /^#{1,6}\s+/.test(line));
  const titleLine = headingCandidates.find((line) => {
    const stripped = line.replace(/^#{1,6}\s+/, '').trim();
    return !/The 30-Second Read/i.test(line) && !/^\[.*\]$/.test(stripped);
  }) || '';
  const title = titleLine.replace(/^#{1,6}\s+/, '').trim();

  const titleIndex = lines.findIndex((line) => line === titleLine.trim());
  const preparedIndex = lines.findIndex((line) => /Prepared by/i.test(line));
  const metadataLines = lines
    .slice(titleIndex + 1)
    .filter((line) => line !== '---' && !/^##\s+The 30-Second Read/.test(line));

  const subtitleLine = metadataLines.find((line) => /\*\*.*\*\*/.test(line) && !/Prepared by/i.test(line));
  const subtitle = subtitleLine ? stripMarkdownDelimiters(subtitleLine) : '';

  const practiceLine = metadataLines.find(
    (line) => !/Prepared by/i.test(line) && !/^[*_#-]/.test(line) && line !== subtitle
  );

  const preparedLine = metadataLines.find((line) => /Prepared by/i.test(line))
    ? stripMarkdownDelimiters(metadataLines.find((line) => /Prepared by/i.test(line)))
    : '';

  const practiceName = practiceLine || inferPracticeName(title, practiceSlug);

  const coverBodyEndOffset = (() => {
    const titlePos = chunk.indexOf(titleLine);
    if (titlePos === -1) return 0;
    let end = titlePos + titleLine.length;
    if (subtitleLine) {
      const pos = chunk.indexOf(subtitleLine, end);
      if (pos >= 0) end = pos + subtitleLine.length;
    }
    if (practiceLine) {
      const pos = chunk.indexOf(practiceLine, end);
      if (pos >= 0) end = pos + practiceLine.length;
    }
    if (preparedLine) {
      const source = metadataLines.find((line) => /Prepared by/i.test(line));
      const pos = chunk.indexOf(source, end);
      if (pos >= 0) end = pos + source.length;
    }
    return end;
  })();

  return {
    title,
    subtitle,
    practiceName,
    preparedByLine: preparedLine,
    coverBodyEndOffset,
  };
}

function parseFindings(chunk) {
  const blocks = chunk.split(/\n(?=###\s+Finding\s+\d+:)/g).map((block) => block.trim()).filter(Boolean);
  return blocks.map((block) => {
    const headingMatch = block.match(/^###\s+Finding\s+(\d+):\s*(.+)$/m);
    const number = headingMatch ? headingMatch[1] : '?';
    const title = headingMatch ? headingMatch[2].trim() : 'Finding';
    const content = headingMatch ? block.slice(block.indexOf(headingMatch[0]) + headingMatch[0].length).trim() : block;

    const whyHeading = '**Why this matters**';
    const doHeading = "**Here's what I'd do**";
    const effortMatch = content.match(/\*\*Effort:\*\*\s*(.+)$/m);
    const effort = effortMatch ? effortMatch[1].trim() : '';
    const contentSansEffort = effortMatch ? content.replace(effortMatch[0], '').trim() : content;

    const whyIndex = contentSansEffort.indexOf(whyHeading);
    const doIndex = contentSansEffort.indexOf(doHeading);

    const openingRaw = whyIndex >= 0 ? contentSansEffort.slice(0, whyIndex).trim() : contentSansEffort.trim();
    const whyRaw = whyIndex >= 0
      ? contentSansEffort.slice(whyIndex + whyHeading.length, doIndex >= 0 ? doIndex : contentSansEffort.length).trim()
      : '';
    const doRaw = doIndex >= 0 ? contentSansEffort.slice(doIndex + doHeading.length).trim() : '';

    const screenshots = extractScreenshotPlaceholders(openingRaw);
    const openingWithoutScreenshots = stripScreenshotLines(openingRaw);

    return {
      number,
      title,
      opening: normalizeBlankLines(openingWithoutScreenshots),
      why: normalizeBlankLines(whyRaw),
      action: normalizeBlankLines(doRaw),
      effort,
      screenshots,
    };
  });
}

function parseOtherItems(chunk) {
  const cleaned = normalizeBlankLines(chunk);
  const matches = cleaned.match(/\*\*[^*]+\*\*[\s\S]*?(?=(?:\n\n\*\*[^*]+\*\*)|$)/g);
  return (matches || []).map((item) => item.trim());
}

function parseSequence(chunk) {
  const sections = [];
  const regex = /\*\*(.+?):\*\*([\s\S]*?)(?=(?:\n\n\*\*.+?:\*\*)|$)/g;
  let match;
  while ((match = regex.exec(normalizeBlankLines(chunk)))) {
    const title = match[1].trim();
    const bullets = match[2]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^-\s+/.test(line))
      .map((line) => line.replace(/^-\s+/, '').trim());
    sections.push({ title, bullets });
  }
  return sections;
}

function parseNextStep(chunk) {
  const cleaned = normalizeBlankLines(chunk);
  const ctaLine = cleaned.match(/^\[Book the Clarity Audit[^\]]*\]$/m);
  const copy = ctaLine ? cleaned.replace(ctaLine[0], '').trim() : cleaned;
  return { copy };
}

function collectScreenshots(findings, screenshotsDir) {
  const missing = [];
  const resolved = new Map();

  for (const finding of findings) {
    for (const shot of finding.screenshots) {
      const filePath = path.join(screenshotsDir, shot.filename);
      if (fs.existsSync(filePath)) {
        resolved.set(shot.filename, {
          ...shot,
          filePath,
          dataUri: imageToDataUri(filePath),
        });
      } else {
        missing.push(shot.filename);
        resolved.set(shot.filename, { ...shot, missing: true });
      }
    }
  }

  return {
    missing: [...new Set(missing)],
    resolved,
  };
}

function buildHtml({ documentData, screenshotState, logoPath, templatePath }) {
  const template = fs.readFileSync(templatePath, 'utf8');
  const logoDataUri = fs.existsSync(logoPath) ? imageToDataUri(logoPath) : '';

  const content = [
    renderCover(documentData, logoDataUri),
    renderOpenerAndSummary(documentData.opener, documentData.summary),
    renderPerspective(documentData.perspective),
    ...documentData.findings.map((finding) => renderFinding(finding, screenshotState)),
    renderOtherItems(documentData.otherItems),
    renderSequence(documentData.sequence),
    renderNextStep(documentData.nextStep),
  ].join('\n');

  const replacements = {
    '{{DOCUMENT_TITLE}}': escapeHtml(documentData.title || 'Clarity Diagnostic'),
    '{{FONT_FACE_CSS}}': buildFontFaceCss(),
    '{{COLOR_ORANGE}}': config.colors.orange,
    '{{COLOR_ACCENT_BLUE}}': config.colors.accentBlue,
    '{{COLOR_GRAY}}': config.colors.gray,
    '{{COLOR_GRAY_LIGHT}}': config.colors.grayLight,
    '{{COLOR_GRAY_BORDER}}': config.colors.grayBorder,
    '{{COLOR_BLACK}}': config.colors.black,
    '{{COLOR_WHITE}}': config.colors.white,
    '{{FONT_PRIMARY}}': `'${config.typography.primaryFont}', ${config.typography.fallbackSans}`,
    '{{FONT_HEADLINE}}': `'${config.typography.headlineFont}', ${config.typography.fallbackSans}`,
    '{{COVER_LOGO_WIDTH}}': String(config.cover.logoWidthPx),
    '{{CONTENT}}': content,
  };

  return Object.entries(replacements).reduce(
    (html, [token, value]) => html.split(token).join(value),
    template
  );
}

function renderCover(documentData, logoDataUri) {
  const cube = buildCubeSvgDataUri();
  return `
    <section class="page cover">
      ${cube ? `<img class="cube-motif" src="${cube}" alt="" />` : ''}
      ${logoDataUri ? `<img class="cover-logo" src="${logoDataUri}" alt="H-Cube Marketing" />` : ''}
      <div class="doc-kicker">The Clarity Diagnostic</div>
      <div class="cover-rule"></div>
      <h1 class="cover-headline">${escapeHtml(documentData.title)}</h1>
      ${documentData.subtitle ? `<div class="cover-subhead">${escapeHtml(documentData.subtitle)}</div>` : ''}
      <div class="cover-practice">${escapeHtml(documentData.practiceName)}</div>
      ${documentData.preparedByLine ? `<div class="cover-meta">${escapeHtml(documentData.preparedByLine.replace(/\|/g, '·'))}</div>` : ''}
    </section>
  `;
}

function renderOpenerAndSummary(opener, summary) {
  return `
    <section class="page content-page">
      <div class="opener body-copy">${opener ? markdownToHtml(opener) : ''}</div>
      <div class="section-rule"></div>
      <div class="summary-callout">${markdownToHtml(summary)}</div>
    </section>
  `;
}

function renderPerspective(copy) {
  return `
    <section class="page content-page">
      <h2 class="section-header">How I See This</h2>
      <div class="body-copy">${markdownToHtml(copy)}</div>
    </section>
  `;
}

function renderFinding(finding, screenshotState) {
  return `
    <section class="page content-page finding">
      <div class="finding-header">
        <div class="finding-badge">${escapeHtml(String(finding.number))}</div>
        <h2 class="finding-title">${escapeHtml(finding.title)}</h2>
      </div>
      <div class="finding-opening">${renderOpeningWithScreenshots(finding, screenshotState)}</div>
      <div class="subsection-label">Why this matters</div>
      <div class="finding-why">${markdownToHtml(finding.why)}</div>
      <div class="subsection-label">Here's what I'd do</div>
      <div class="finding-do">${markdownToHtml(finding.action)}</div>
      ${finding.effort ? `<div class="effort-tag">Effort: ${escapeHtml(finding.effort.replace(/^Effort:\s*/i, ''))}</div>` : ''}
    </section>
  `;
}

function renderOpeningWithScreenshots(finding, screenshotState) {
  const paragraphs = splitParagraphs(finding.opening);
  const first = paragraphs.shift() || '';
  const rest = paragraphs.join('\n\n');
  const screenshots = finding.screenshots.map((shot) => {
    const resolved = screenshotState.resolved.get(shot.filename);
    if (!resolved || resolved.missing) {
      return `
        <div class="screenshot-card">
          <div class="missing-screenshot">Screenshot pending: ${escapeHtml(shot.filename)}</div>
          ${shot.caption ? `<div class="screenshot-caption">${escapeHtml(shot.caption)}</div>` : ''}
        </div>
      `;
    }
    return `
      <figure class="screenshot-card">
        <div class="screenshot-frame"><img src="${resolved.dataUri}" alt="${escapeHtml(shot.caption || shot.filename)}" /></div>
        ${shot.caption ? `<figcaption class="screenshot-caption">${escapeHtml(shot.caption)}</figcaption>` : ''}
      </figure>
    `;
  }).join('');

  const stackClass = finding.screenshots.length === 1 ? 'screenshot-stack single-shot' : 'screenshot-stack';
  return `
    ${first ? markdownToHtml(first) : ''}
    ${screenshots ? `<div class="${stackClass}">${screenshots}</div>` : ''}
    ${rest ? markdownToHtml(rest) : ''}
  `;
}

function renderOtherItems(items) {
  return `
    <section class="page content-page">
      <h2 class="section-header">Other Things I Noticed</h2>
      <div class="cards-grid">
        ${items.map((item) => `<div class="note-card">${markdownToHtml(item)}</div>`).join('')}
      </div>
    </section>
  `;
}

function renderSequence(sequence) {
  return `
    <section class="page content-page">
      <h2 class="section-header">How I'd Sequence the Fixes</h2>
      <div class="sequence-grid">
        ${sequence.map((block) => `
          <div class="sequence-block">
            <div class="sequence-title">${escapeHtml(block.title)}</div>
            <ul>${block.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul>
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

function renderNextStep(nextStep) {
  return `
    <section class="page content-page next-step-page">
      <div>
        <h2 class="section-header">The Next Step</h2>
        <blockquote class="cta-quote">${markdownToHtml(nextStep.copy)}</blockquote>
        <a class="cta-button" href="${escapeAttribute(config.cta.url)}">${escapeHtml(config.cta.label)}</a>
      </div>
      <div class="signoff">${config.signoff.map((line) => `<div>${escapeHtml(line)}</div>`).join('')}</div>
    </section>
  `;
}

async function renderPdf(htmlPath, pdfPath) {
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: pdfPath,
      ...config.pdf,
    });
  } finally {
    await browser.close();
  }
}

async function stampFooter({ inputPath, outputPath, practiceName, logoPath }) {
  const pdfBytes = fs.readFileSync(inputPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const footerColor = rgb(0.345, 0.349, 0.357);
  let logoImage = null;

  if (fs.existsSync(logoPath)) {
    try {
      logoImage = await pdfDoc.embedPng(fs.readFileSync(logoPath));
    } catch {
      logoImage = null;
    }
  }

  pages.forEach((page, index) => {
    if (index === 0) return;

    const { width } = page.getSize();
    const y = config.footer.bottom;
    const leftX = config.footer.left;
    const rightX = width - config.footer.right;
    const pageLabel = String(index + 1);

    page.drawText(practiceName, {
      x: leftX,
      y,
      size: config.footer.textSize,
      font,
      color: footerColor,
    });

    const pageTextWidth = font.widthOfTextAtSize(pageLabel, config.footer.textSize);
    page.drawText(pageLabel, {
      x: (width / 2) - (pageTextWidth / 2),
      y,
      size: config.footer.textSize,
      font,
      color: footerColor,
    });

    if (logoImage) {
      const scale = config.footer.wordmarkWidth / logoImage.width;
      page.drawImage(logoImage, {
        x: rightX - config.footer.wordmarkWidth,
        y: y - 4,
        width: config.footer.wordmarkWidth,
        height: logoImage.height * scale,
      });
    } else {
      const wordmark = 'H-Cube Marketing';
      const wordmarkWidth = font.widthOfTextAtSize(wordmark, config.footer.textSize);
      page.drawText(wordmark, {
        x: rightX - wordmarkWidth,
        y,
        size: config.footer.textSize,
        font,
        color: footerColor,
      });
    }
  });

  fs.writeFileSync(outputPath, await pdfDoc.save());
}

function markdownToHtml(markdown) {
  return marked.parse(markdown || '').trim();
}

function buildFontFaceCss() {
  const fonts = [
    { file: 'inter-latin-400-normal.woff2', weight: 400, style: 'normal' },
    { file: 'inter-latin-400-italic.woff2', weight: 400, style: 'italic' },
    { file: 'inter-latin-500-normal.woff2', weight: 500, style: 'normal' },
    { file: 'inter-latin-600-normal.woff2', weight: 600, style: 'normal' },
    { file: 'inter-latin-700-normal.woff2', weight: 700, style: 'normal' },
  ];
  return fonts.map(({ file, weight, style }) => {
    const fontPath = path.join(__dirname, 'node_modules', '@fontsource', 'inter', 'files', file);
    if (!fs.existsSync(fontPath)) return '';
    const fontUrl = `file://${fontPath}`;
    return `
      @font-face {
        font-family: 'Inter';
        font-style: ${style};
        font-weight: ${weight};
        font-display: swap;
        src: url('${fontUrl}') format('woff2');
      }
    `;
  }).join('\n');
}

function buildCubeSvgDataUri() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" fill="none" stroke="${config.colors.orange}" stroke-width="2">
      <g opacity="0.75">
        ${Array.from({ length: 4 }).map((_, row) => Array.from({ length: 4 }).map((__, col) => cubePath(28 + col * 52 + (row % 2 ? 26 : 0), 28 + row * 42)).join('')).join('')}
      </g>
    </svg>
  `;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function cubePath(x, y) {
  const s = 22;
  const points = [
    [x, y],
    [x + s, y - s / 2],
    [x + 2 * s, y],
    [x + s, y + s / 2],
  ];
  const bottom = [
    [x, y],
    [x, y + s],
    [x + s, y + s * 1.5],
    [x + s, y + s / 2],
  ];
  const right = [
    [x + 2 * s, y],
    [x + 2 * s, y + s],
    [x + s, y + s * 1.5],
    [x + s, y + s / 2],
  ];
  return [points, bottom, right]
    .map((poly) => `<polygon points="${poly.map(([px, py]) => `${px},${py}`).join(' ')}" />`)
    .join('');
}

function extractScreenshotPlaceholders(text) {
  const shots = [];
  const regexes = [
    /^\[INSERT SCREENSHOT:\s*([^\]—]+?)\s*[—-]\s*Caption to use:\s*"([^"]+)"\]$/gim,
    /^\[Screenshot:\s*([^\]—]+?)\s*[—-]\s*([^\]]+)\]$/gim,
  ];
  for (const regex of regexes) {
    let match;
    while ((match = regex.exec(text))) {
      shots.push({
        filename: match[1].trim(),
        caption: (match[2] || '').trim().replace(/^"|"$/g, ''),
      });
    }
  }
  return shots;
}

function stripScreenshotLines(text) {
  return text
    .replace(/^\[INSERT SCREENSHOT:[^\]]+\]$/gim, '')
    .replace(/^\[Screenshot:[^\]]+\]$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function inferPracticeName(title, practiceSlug) {
  const cut = title.split(' has ')[0].split(' is ')[0].trim();
  if (cut) return cut;
  return practiceSlug
    .split(/[_-]/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function splitParagraphs(text) {
  return normalizeBlankLines(text)
    .split(/\n\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function sliceSection(text, start, end, heading) {
  if (start < 0) return '';
  return text.slice(start + heading.length, end).trim();
}

function normalizeBlankLines(text) {
  return (text || '').replace(/\n{3,}/g, '\n\n').trim();
}

function stripMarkdownDelimiters(text) {
  return text.replace(/^\*+|\*+$/g, '').trim();
}

function imageToDataUri(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream';
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
