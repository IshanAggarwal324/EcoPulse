const PDFDocument = require('pdfkit');
const path = require('path');
const { BRAND, FONTS, PAGE_DEFAULTS } = require('./pdfConstants');
const {
  renderCoverPage,
  renderExecutiveSummary,
  renderGridEnergyTable,
  renderTradingProfitTable,
  renderNodeOverview,
  renderForecastSection,
  renderDisclaimerFooter,
} = require('../templates/reportTemplate');

function createPdfDocument(options = {}) {
  const doc = new PDFDocument({
    ...PAGE_DEFAULTS,
    ...options,
    margins: { ...PAGE_DEFAULTS.margins, ...(options.margins || {}) },
  });

  return doc;
}

function addPageNumber(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const pageLabel = `${i + 1}`;
    doc
      .font(FONTS.regular)
      .fontSize(9)
      .fillColor(BRAND.textMuted)
      .text(
        pageLabel,
        doc.page.margins.left,
        doc.page.height - 40,
        { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: 'center' }
      );
  }
}

function addHeaderBar(doc, title) {
  const { width } = doc.page;
  doc
    .rect(0, 0, width, 6)
    .fill(BRAND.primary);

  doc
    .font(FONTS.bold)
    .fontSize(10)
    .fillColor(BRAND.textMuted)
    .text(title, doc.page.margins.left, 16, {
      width: width - doc.page.margins.left - doc.page.margins.right,
      align: 'right',
    });
}

function generateReportPdf({ metrics, narrative, user }) {
  return new Promise((resolve, reject) => {
    const doc = createPdfDocument();
    const chunks = [];

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const meta = metrics.meta || {};
    const period = meta.period || '7d';
    const generatedAt = meta.generatedAt || new Date().toISOString();
    const isDemoData = meta.isDemoData || false;

    renderCoverPage(doc, { user, period, generatedAt });

    renderExecutiveSummary(doc, narrative || null);

    if (metrics.gridEnergy) {
      renderGridEnergyTable(doc, metrics.gridEnergy);
    }

    renderTradingProfitTable(doc, metrics.gridTrading || null, metrics.personalProfit || null);

    if (metrics.nodeOverview) {
      renderNodeOverview(doc, metrics.nodeOverview);
    }

    if (metrics.forecastOutlook) {
      renderForecastSection(doc, metrics.forecastOutlook);
    }

    addPageNumber(doc);

    renderDisclaimerFooter(doc, isDemoData);

    doc.end();
  });
}

function buildReportFilename(period) {
  const safePeriod = period || 'custom';
  const date = new Date().toISOString().split('T')[0];
  return `ecopulse-report-${safePeriod}-${date}.pdf`;
}

module.exports = {
  createPdfDocument,
  generateReportPdf,
  buildReportFilename,
  addPageNumber,
  addHeaderBar,
  BRAND,
  FONTS,
  PAGE_DEFAULTS,
};
