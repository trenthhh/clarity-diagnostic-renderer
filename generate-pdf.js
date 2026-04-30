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
  const html = buildHtml({
    documentData,
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
    opener: parseStructuredContent(openerChunk),
    summary: parseStructuredContent(summaryChunk, { allowGraphics: true }),
    perspective: parseStructuredContent(howChunk, { allowGraphics: true }),
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
    if (!headingMatch) return null;
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

    return {
      number,
      title,
      opening: parseStructuredContent(openingRaw, { allowGraphics: true }),
      why: parseStructuredContent(whyRaw, { allowGraphics: true }),
      action: parseStructuredContent(doRaw, { allowGraphics: true }),
      effort,
    };
  }).filter(Boolean);
}

function parseOtherItems(chunk) {
  const cleaned = normalizeBlankLines(chunk);
  const matches = cleaned.match(/\*\*[^*]+\*\*[\s\S]*?(?=(?:\n\n\*\*[^*]+\*\*)|$)/g);
  return (matches || []).map((item) => item.trim());
}

function parseSequence(chunk) {
  const sections = [];
  const regex = /\*\*(.+?):?\*\*([\s\S]*?)(?=(?:\n\n\*\*.+?:?\*\*)|$)/g;
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
  const copy = cleaned
    .replace(/^\[Book the Clarity Audit[^\]]*\]\s*$/gim, '')
    .replace(/^Trent Wehrhahn.*$/gim, '')
    .replace(/^H-Cube Marketing.*$/gim, '')
    .replace(/^trent@.*$/gim, '')
    .replace(/^hcubemarketing\.com.*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { copy };
}

function buildHtml({ documentData, logoPath, templatePath }) {
  const template = fs.readFileSync(templatePath, 'utf8');
  const logoDataUri = fs.existsSync(logoPath) ? imageToDataUri(logoPath) : '';

  const content = [
    renderCover(documentData, logoDataUri, documentData.opener),
    renderOpenerAndSummary(documentData.summary),
    renderPerspective(documentData.perspective),
    ...documentData.findings.map((finding) => renderFinding(finding)),
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

function renderCover(documentData, logoDataUri, opener) {
  const cube = buildCubeSvgDataUri();
  const openerHtml = opener && opener.length
    ? `<div class="cover-intro">${renderStructuredContent(opener)}</div>`
    : '';
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
      ${openerHtml}
    </section>
  `;
}

function renderOpenerAndSummary(summary) {
  return `
    <section class="page content-page">
      <div class="summary-callout">${renderStructuredContent(summary)}</div>
    </section>
  `;
}

function renderPerspective(copy) {
  return `
    <section class="page content-page">
      <h2 class="section-header">How I See This</h2>
      <div class="body-copy">${renderStructuredContent(copy)}</div>
    </section>
  `;
}

function renderFinding(finding) {
  return `
    <section class="page content-page finding">
      <div class="finding-header">
        <div class="finding-badge">${escapeHtml(String(finding.number))}</div>
        <h2 class="finding-title">${escapeHtml(finding.title)}</h2>
      </div>
      <div class="finding-opening">${renderStructuredContent(finding.opening)}</div>
      <div class="subsection-label">Why this matters</div>
      <div class="finding-why">${renderStructuredContent(finding.why)}</div>
      <div class="subsection-label">Here's what I'd do</div>
      <div class="finding-do">${renderStructuredContent(finding.action)}</div>
      ${finding.effort ? `<div class="effort-tag">Effort: ${escapeHtml(finding.effort.replace(/^Effort:\s*/i, ''))}</div>` : ''}
    </section>
  `;
}

function renderStructuredContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return markdownToHtml(content);
  return (content.blocks || []).map((block) => {
    if (block.type === 'markdown') return markdownToHtml(block.value);
    if (block.type === 'pull_quote') return renderPullQuote(block);
    if (block.type === 'stat_callout') return renderStatCallout(block);
    if (block.type === 'sidebar') return renderSidebar(block);
    if (block.type === 'graphic') return renderGraphic(block);
    return '';
  }).join('\n');
}

function renderPullQuote(block) {
  return `<div class="pull-quote">${escapeHtml(block.text)}</div>`;
}

function renderStatCallout(block) {
  return `
    <div class="stat-callout">
      <span class="stat-callout-number">${escapeHtml(block.value)}</span>
      <span class="stat-callout-label">${escapeHtml(block.label)}</span>
      <div class="stat-callout-explanation">${escapeHtml(block.explanation)}</div>
    </div>
  `;
}

function renderSidebar(block) {
  return `<div class="content-sidebar">${escapeHtml(block.text)}</div>`;
}

function renderGraphic(block) {
  if (block.graphicType === 'competitive_ranking') return renderCompetitiveRanking(block);
  if (block.graphicType === 'comparison_stat') return renderComparisonStat(block);
  if (block.graphicType === 'single_big_stat') return renderSingleBigStat(block);
  if (block.graphicType === 'maps_pack') return renderMapsPack(block);
  return '';
}

function renderCompetitiveRanking(block) {
  const maxValue = Math.max(...block.items.map((item) => item.value), 1);
  return `
    <figure class="graphic-panel competitive-ranking">
      <div class="ranking-rows">
        ${block.items.map((item) => `
          <div class="ranking-row">
            <div class="ranking-name">${escapeHtml(item.name)}</div>
            <div class="ranking-bar-track">
              <div class="ranking-bar${item.highlight ? ' is-highlight' : ''}" style="width: ${Math.max(6, (item.value / maxValue) * 100)}%">
                <span class="ranking-value">${escapeHtml(String(item.value))}</span>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
      ${block.caption ? `<figcaption class="graphic-caption">${escapeHtml(block.caption)}</figcaption>` : ''}
    </figure>
  `;
}

function renderComparisonStat(block) {
  return `
    <figure class="graphic-panel comparison-stat">
      <div class="comparison-stat-grid">
        ${block.items.map((item, index) => `
          <div class="comparison-stat-item${index === block.highlightIndex ? ' is-highlight' : ''}">
            <span class="comparison-stat-value">${escapeHtml(item.value)}</span>
            <span class="comparison-stat-label">${escapeHtml(item.label)}</span>
          </div>
        `).join('')}
      </div>
      ${block.caption ? `<figcaption class="graphic-caption">${escapeHtml(block.caption)}</figcaption>` : ''}
    </figure>
  `;
}

function renderSingleBigStat(block) {
  return `
    <figure class="graphic-panel single-big-stat">
      <span class="single-big-stat-value">${escapeHtml(block.value)}</span>
      <span class="single-big-stat-label">${escapeHtml(block.label)}</span>
      ${block.context ? `<div class="single-big-stat-context">${escapeHtml(block.context)}</div>` : ''}
      ${block.caption ? `<figcaption class="graphic-caption">${escapeHtml(block.caption)}</figcaption>` : ''}
    </figure>
  `;
}

function renderMapsPack(block) {
  return `
    <figure class="graphic-panel maps-pack-graphic">
      <div class="maps-pack-list">
        ${block.pack.map((item, index) => `
          <div class="maps-pack-row">
            <span class="maps-pack-pin">📍</span>
            <span class="maps-pack-position">Pack ${index + 1}</span>
            <span class="maps-pack-name">${escapeHtml(item.name)}</span>
            <span class="maps-pack-value">${escapeHtml(String(item.value))}</span>
          </div>
        `).join('')}
        <div class="maps-pack-row maps-pack-missing">
          <span class="maps-pack-pin">—</span>
          <span class="maps-pack-position">Not shown</span>
          <span class="maps-pack-name">${escapeHtml(block.practice)}</span>
        </div>
      </div>
      ${block.caption ? `<figcaption class="graphic-caption">${escapeHtml(block.caption)}</figcaption>` : ''}
    </figure>
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

function parseStructuredContent(text, options = {}) {
  const normalized = normalizeBlankLines(text);
  if (!normalized) return { blocks: [] };

  const blocks = [];
  const lines = normalized.split('\n');
  const markdownBuffer = [];

  const flushMarkdown = () => {
    const value = normalizeBlankLines(markdownBuffer.join('\n'));
    if (value) blocks.push({ type: 'markdown', value });
    markdownBuffer.length = 0;
  };

  for (const line of lines) {
    const marker = parseMarkerLine(line.trim(), options);
    if (marker) {
      flushMarkdown();
      blocks.push(marker);
    } else {
      markdownBuffer.push(line);
    }
  }

  flushMarkdown();
  return { blocks };
}

function parseMarkerLine(line, options = {}) {
  if (!line) return null;

  let match = line.match(/^\[PULL QUOTE:\s*"([^"]+)"\]$/i);
  if (match) return { type: 'pull_quote', text: match[1].trim() };

  match = line.match(/^\[STAT CALLOUT:\s*(.+?)\s+[—-]\s+(.+?)\s+[—-]\s+([^\]]+)\]$/i);
  if (match) {
    return {
      type: 'stat_callout',
      value: match[1].trim(),
      label: match[2].trim(),
      explanation: match[3].trim(),
    };
  }

  match = line.match(/^\[SIDEBAR:\s*"([^"]+)"\]$/i);
  if (match) return { type: 'sidebar', text: match[1].trim() };

  if (options.allowGraphics) {
    const graphic = extractGraphicMarker(line);
    if (graphic) return graphic;
  }

  return null;
}

function extractGraphicMarker(line) {
  const match = line.match(/^\[GRAPHIC:\s*([^\]—]+?)\s+[—-]\s+(.+?)(?:\s+[—-]\s+Highlight:\s*([^\]—]+?))?\s+[—-]\s+Caption:\s*"([^"]+)"\]$/i);
  if (!match) return null;

  const graphicType = match[1].trim();
  const data = match[2].trim();
  const highlight = (match[3] || '').trim();
  const caption = match[4].trim();

  if (graphicType === 'competitive_ranking') {
    return {
      type: 'graphic',
      graphicType,
      caption,
      highlight,
      items: parseGraphicPairs(data).map((item) => ({
        ...item,
        highlight: item.name === highlight,
      })),
    };
  }

  if (graphicType === 'comparison_stat') {
    const items = parseComparisonStatData(data);
    const highlightIndex = items.findIndex((item) => item.label === highlight || item.value === highlight || `${item.label}: ${item.value}` === highlight);
    return {
      type: 'graphic',
      graphicType,
      caption,
      highlight,
      items,
      highlightIndex: highlightIndex >= 0 ? highlightIndex : 0,
    };
  }

  if (graphicType === 'single_big_stat') {
    const parsed = parseSingleBigStatData(data);
    return {
      type: 'graphic',
      graphicType,
      caption,
      highlight,
      ...parsed,
    };
  }

  if (graphicType === 'maps_pack') {
    return {
      type: 'graphic',
      graphicType,
      caption,
      highlight,
      ...parseMapsPackData(data),
    };
  }

  return null;
}

function parseGraphicPairs(data) {
  return data.split(/\s*,\s*/).map((part) => {
    const [name, value] = part.split(/\s*:\s*/);
    return { name: (name || '').trim(), value: Number(String(value || '').replace(/[^\d.]/g, '')) || 0 };
  }).filter((item) => item.name);
}

function parseComparisonStatData(data) {
  return splitGraphicList(data).map((part) => {
    const cleaned = part.replace(/^"|"$/g, '').trim();
    const segments = cleaned.split(/\s+vs\s+/i);
    if (segments.length === 2) return segments.map(parseComparisonSegment);
    return [parseComparisonSegment(cleaned)];
  }).flat();
}

function parseComparisonSegment(segment) {
  const cleaned = segment.replace(/^"|"$/g, '').trim();
  const match = cleaned.match(/^(.*?):\s*(.+)$/);
  if (!match) return { label: cleaned, value: '' };
  return { label: match[1].trim(), value: match[2].trim() };
}

function parseSingleBigStatData(data) {
  const quotedParts = [...data.matchAll(/"([^"]+)"/g)].map((match) => match[1].trim());
  const parts = quotedParts.length > 0 ? quotedParts : data.split(/\s+[—-]\s+/).map((part) => part.trim());
  const value = (parts[0] || '').replace(/^"|"$/g, '').trim();
  const label = (parts[1] || '').replace(/^"|"$/g, '').trim();
  const captionContext = parts[2] || '';
  const contextMatch = captionContext.match(/^Context:\s*(.+)$/i);
  return {
    value,
    label,
    context: contextMatch ? contextMatch[1].trim() : captionContext.replace(/^"|"$/g, '').trim(),
  };
}

function parseMapsPackData(data) {
  const entries = splitGraphicList(data);
  const pack = [];
  let practice = '';

  for (const entry of entries) {
    const trimmed = entry.trim();
    let match = trimmed.match(/^Pack\d+:\s*(.+?)\s*\(([^)]+)\)$/i);
    if (match) {
      pack.push({ name: match[1].trim(), value: match[2].trim() });
      continue;
    }
    match = trimmed.match(/^Practice:\s*(.+)$/i);
    if (match) practice = match[1].trim();
  }

  return { pack, practice };
}

function splitGraphicList(value) {
  const parts = [];
  let current = '';
  let inQuotes = false;
  for (const char of value) {
    if (char === '"') inQuotes = !inQuotes;
    if (char === ',' && !inQuotes) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function inferPracticeName(title, practiceSlug) {
  const cut = title.split(' has ')[0].split(' is ')[0].trim();
  if (cut) return cut;
  return practiceSlug
    .split(/[_-]/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
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
