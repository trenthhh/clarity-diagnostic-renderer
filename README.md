# H-Cube Clarity Diagnostic Renderer

Standalone Node.js CLI for rendering a Clarity Diagnostic markdown file into a branded PDF.

## Stack

- Node.js
- Puppeteer
- marked
- pdf-lib

## What it does

Given a folder shaped like this:

```text
HCube_Clarity_Diagnostic/
├── clarity_diagnostics/
│   └── [practicename]_clarity_diagnostic.md
├── research_briefs/
│   └── screenshots/
│       └── [practicename]_*.png
└── deliverables/
```

Run:

```bash
node generate-pdf.js [practicename]
```

Example:

```bash
node generate-pdf.js desertdentalarts
```

The script will:

1. find the markdown file by naming convention
2. replace screenshot placeholders with rendered image blocks
3. apply the H-Cube HTML/CSS template
4. render a PDF
5. create `deliverables/` if needed
6. write `deliverables/[practicename]_clarity_diagnostic.pdf`

## Install

```bash
npm install
```

## Usage

Run from the diagnostic project folder itself:

```bash
cd HCube_Clarity_Diagnostic
node /path/to/clarity-diagnostic-renderer/generate-pdf.js desertdentalarts
```

No path arguments are required or supported. The script resolves everything from the current working directory.

## Sample renders in this repo

The sample source files in this repo live under `samples/`.

To render them:

```bash
npm run render:samples
```

That writes PDFs to:

```text
samples/deliverables/
```

## Screenshot placeholder formats supported

Primary spec format:

```text
[INSERT SCREENSHOT: filename.png — Caption to use: "caption text here"]
```

Legacy/sample format also supported:

```text
[Screenshot: filename.png — Caption text here]
```

## Missing screenshots

If a referenced screenshot is missing:

- the render continues
- a placeholder note is inserted in the document
- all missing files are logged at the end

## Config

All common tweak points live in `config.js`:

- brand colors
- font names
- logo path
- markdown / screenshot / output directories
- CTA label and URL
- sign-off block
- PDF settings

## Common modifications

### Change the CTA destination

Edit `config.js`:

```js
cta: {
  label: 'Book the Clarity Audit',
  url: 'https://hcubemarketing.com/request-audit',
}
```

### Change sign-off text

Edit the `signoff` array in `config.js`.

### Change colors or typography

Edit the `colors` and `typography` sections in `config.js`.

### Change layout styling

Edit `template.html`.

## Notes

- The renderer uses local Inter font files from `@fontsource/inter` so it does not depend on Google Fonts at runtime.
- Footer branding and page numbers are stamped after render so the cover can remain footer-free.
- Current sample output lands at 12 pages for Bird Family Dental and 14 pages for Desert Dental Arts.

## Current sample caveat

The Bird Family Dental sample markdown references screenshots that are not currently present in this repo, so its sample PDF intentionally renders placeholder blocks for those missing assets and logs the missing filenames.
