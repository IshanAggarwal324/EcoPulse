/**
 * Generate EcoPulse_Deployment_Readiness.pdf from the Markdown source.
 * Usage: npm run docs:pdf (from repo root)
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const INPUT = path.join(__dirname, 'EcoPulse_Deployment_Readiness.md');
const OUTPUT = path.join(__dirname, 'EcoPulse_Deployment_Readiness.pdf');

async function main() {
  if (!fs.existsSync(INPUT)) {
    console.error('Missing source file:', INPUT);
    process.exit(1);
  }

  let mdToPdf;
  try {
    mdToPdf = require('md-to-pdf');
  } catch {
    console.error('md-to-pdf is not installed. Run: npm install');
    process.exit(1);
  }

  const cssPath = path.join(__dirname, 'pdf-styles.css');
  const pdfOptions = {
    dest: OUTPUT,
    pdf_options: {
      format: 'A4',
      margin: { top: '20mm', right: '18mm', bottom: '20mm', left: '18mm' },
      printBackground: true,
    },
    stylesheet: fs.existsSync(cssPath) ? cssPath : undefined,
    body_class: 'deployment-readiness',
    marked_options: {
      headerIds: true,
      mangle: false,
    },
    launch_options: {
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  };

  console.log('Generating PDF from', INPUT);
  await mdToPdf.mdToPdf(
    { path: INPUT },
    {
      ...pdfOptions,
      basedir: __dirname,
    }
  );

  if (!fs.existsSync(OUTPUT)) {
    console.error('PDF was not created at', OUTPUT);
    process.exit(1);
  }

  const stats = fs.statSync(OUTPUT);
  console.log('Created:', OUTPUT);
  console.log('Size:', (stats.size / 1024).toFixed(1), 'KB');
}

main().catch((err) => {
  console.error('PDF generation failed:', err.message);
  process.exit(1);
});
