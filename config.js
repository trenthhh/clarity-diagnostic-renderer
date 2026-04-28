const path = require('path');

module.exports = {
  paths: {
    logo: path.join('assets', 'hcube-logo.png'),
    markdownDir: 'clarity_diagnostics',
    screenshotsDir: path.join('research_briefs', 'screenshots'),
    deliverablesDir: 'deliverables',
    template: 'template.html',
  },
  pdf: {
    format: 'Letter',
    printBackground: true,
    preferCSSPageSize: true,
    margin: {
      top: '0in',
      right: '0in',
      bottom: '0in',
      left: '0in',
    },
  },
  typography: {
    primaryFont: 'Inter',
    headlineFont: 'Inter',
    fallbackSans: "'Helvetica Neue', Arial, sans-serif",
  },
  colors: {
    orange: '#F7931E',
    accentBlue: '#0077B6',
    gray: '#58595B',
    grayLight: '#F5F5F5',
    grayBorder: '#D8D8D8',
    black: '#231F20',
    white: '#FFFFFF',
  },
  footer: {
    textSize: 10,
    bottom: 24,
    left: 42,
    right: 42,
    wordmarkWidth: 54,
  },
  cover: {
    logoWidthPx: 190,
  },
  finding: {
    badgeSizePx: 28,
    screenshotMaxWidthPercent: 90,
  },
  cta: {
    label: 'Book the Clarity Audit',
    url: 'https://hcubemarketing.com/request-audit',
  },
  signoff: [
    'Trent Wehrhahn',
    'H-Cube Marketing',
    'trent@hcubemarketing.com',
    'hcubemarketing.com',
  ],
};
