const { BRAND, FONTS } = require('../services/pdfConstants');

const PERIOD_LABELS = {
  '7d': 'Last 7 Days',
  '14d': 'Last 14 Days',
  '30d': 'Last 30 Days',
};

function renderCoverPage(doc, { user, period, generatedAt }) {
  const { width, height } = doc.page;
  const margin = doc.page.margins.left;
  const contentWidth = width - margin - doc.page.margins.right;
  const now = generatedAt ? new Date(generatedAt) : new Date();

  doc.rect(0, 0, width, height).fill(BRAND.secondary);

  doc
    .rect(0, height * 0.38, width, 4)
    .fill(BRAND.accent);

  doc
    .font(FONTS.bold)
    .fontSize(36)
    .fillColor(BRAND.textLight)
    .text('EcoPulse', margin, 120, { width: contentWidth, align: 'center' });

  doc
    .font(FONTS.regular)
    .fontSize(14)
    .fillColor(BRAND.accent)
    .text('Smart Energy Grid Report', margin, 170, { width: contentWidth, align: 'center' });

  doc.moveDown(1.5);

  const periodLabel = PERIOD_LABELS[period] || period || 'Custom Period';
  doc
    .font(FONTS.bold)
    .fontSize(20)
    .fillColor(BRAND.textLight)
    .text(periodLabel, margin, 240, { width: contentWidth, align: 'center' });

  doc.moveDown(1);

  doc
    .font(FONTS.regular)
    .fontSize(11)
    .fillColor('#94a3b8')
    .text(
      `Generated on ${now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`,
      margin,
      280,
      { width: contentWidth, align: 'center' }
    );

  if (user) {
    const blockTop = height * 0.48 + 30;

    doc
      .font(FONTS.bold)
      .fontSize(12)
      .fillColor(BRAND.textLight)
      .text('Prepared for', margin, blockTop, { width: contentWidth, align: 'center' });

    const displayName = user.name || user.email || 'EcoPulse User';
    doc
      .font(FONTS.regular)
      .fontSize(14)
      .fillColor(BRAND.accent)
      .text(displayName, margin, blockTop + 22, { width: contentWidth, align: 'center' });

    if (user.email) {
      doc
        .font(FONTS.regular)
        .fontSize(10)
        .fillColor('#94a3b8')
        .text(user.email, margin, blockTop + 44, { width: contentWidth, align: 'center' });
    }
  }

  doc
    .font(FONTS.regular)
    .fontSize(9)
    .fillColor('#64748b')
    .text(
      'Powered by EcoPulse — Decentralized Smart Energy Trading Platform',
      margin,
      height - 80,
      { width: contentWidth, align: 'center' }
    );

  doc
    .rect(0, height - 6, width, 6)
    .fill(BRAND.accent);

  doc.page.margins.top = 60;
  doc.x = margin;
  doc.y = doc.page.margins.top;
}

function renderExecutiveSummary(doc, narrative) {
  const { width } = doc.page;
  const margin = doc.page.margins.left;
  const contentWidth = width - margin - doc.page.margins.right;

  doc.addPage();

  doc
    .font(FONTS.bold)
    .fontSize(16)
    .fillColor(BRAND.primary)
    .text('Executive Summary', margin, doc.y, { width: contentWidth });

  doc.moveDown(0.4);

  doc
    .moveTo(margin, doc.y)
    .lineTo(margin + contentWidth, doc.y)
    .lineWidth(1)
    .strokeColor(BRAND.borderColor)
    .stroke();

  doc.moveDown(0.6);

  if (!narrative) {
    doc
      .font(FONTS.italic)
      .fontSize(10)
      .fillColor(BRAND.textMuted)
      .text('No summary available for this period.', margin, doc.y, { width: contentWidth });
    doc.moveDown(1);
    return;
  }

  const summary = narrative.summary || narrative;
  const paragraphs = typeof summary === 'string'
    ? summary.split(/\n{2,}/).filter(p => p.trim())
    : [String(summary)];

  for (const para of paragraphs) {
    doc
      .font(FONTS.regular)
      .fontSize(10)
      .fillColor(BRAND.textDark)
      .text(para.trim(), margin, doc.y, {
        width: contentWidth,
        lineGap: 3,
      });
    doc.moveDown(0.6);
  }

  if (Array.isArray(narrative.highlights) && narrative.highlights.length > 0) {
    doc.moveDown(0.3);

    doc
      .font(FONTS.bold)
      .fontSize(11)
      .fillColor(BRAND.primary)
      .text('Key Highlights', margin, doc.y, { width: contentWidth });

    doc.moveDown(0.3);

    for (const highlight of narrative.highlights) {
      const bulletX = margin + 10;
      const textX = margin + 22;

      doc
        .font(FONTS.regular)
        .fontSize(10)
        .fillColor(BRAND.accent)
        .text('\u2022', margin + 4, doc.y, { continued: false });

      doc
        .moveUp()
        .font(FONTS.regular)
        .fontSize(10)
        .fillColor(BRAND.textDark)
        .text(highlight, textX, doc.y, {
          width: contentWidth - 22,
          lineGap: 2,
        });

      doc.moveDown(0.2);
    }

    doc.moveDown(0.4);
  }
}

function ensureSpace(doc, needed) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) {
    doc.addPage();
  }
}

function renderSectionHeader(doc, title) {
  const { width } = doc.page;
  const margin = doc.page.margins.left;
  const contentWidth = width - margin - doc.page.margins.right;

  doc
    .font(FONTS.bold)
    .fontSize(14)
    .fillColor(BRAND.primary)
    .text(title, margin, doc.y, { width: contentWidth });

  doc.moveDown(0.3);

  doc
    .moveTo(margin, doc.y)
    .lineTo(margin + contentWidth, doc.y)
    .lineWidth(1)
    .strokeColor(BRAND.borderColor)
    .stroke();

  doc.moveDown(0.5);
}

function renderTableRow(doc, cols, options = {}) {
  const { widths, isHeader = false, isLast = false } = options;
  const margin = doc.page.margins.left;
  const rowHeight = 22;
  const startX = margin;

  ensureSpace(doc, rowHeight + 2);

  const y = doc.y;

  if (isHeader) {
    doc.rect(startX, y, widths.reduce((a, b) => a + b, 0), rowHeight).fill(BRAND.primary);
  } else if (!isLast) {
    doc
      .moveTo(startX, y + rowHeight)
      .lineTo(startX + widths.reduce((a, b) => a + b, 0), y + rowHeight)
      .lineWidth(0.5)
      .strokeColor('#e2e8f0')
      .stroke();
  }

  let colX = startX;
  for (let i = 0; i < cols.length; i++) {
    const align = i === 0 ? 'left' : 'right';
    const padding = i === 0 ? 8 : 8;

    doc
      .font(isHeader ? FONTS.bold : FONTS.regular)
      .fontSize(9.5)
      .fillColor(isHeader ? BRAND.textLight : BRAND.textDark)
      .text(
        String(cols[i]),
        colX + (i === 0 ? 8 : 0),
        y + 6,
        { width: widths[i] - (i === 0 ? 8 : 8) * 1, align, lineBreak: false }
      );

    colX += widths[i];
  }

  doc.y = y + rowHeight;
}

function formatKwh(value) {
  if (value == null) return '\u2014';
  return `${Number(value).toFixed(1)} kWh`;
}

function formatNumber(value) {
  if (value == null) return '\u2014';
  return Number(value).toLocaleString('en-US');
}

function renderGridEnergyTable(doc, gridEnergy) {
  const { width } = doc.page;
  const contentWidth = width - doc.page.margins.left - doc.page.margins.right;
  const colWidths = [contentWidth * 0.55, contentWidth * 0.45];

  renderSectionHeader(doc, 'Grid Energy Overview');

  if (!gridEnergy) {
    doc
      .font(FONTS.italic)
      .fontSize(10)
      .fillColor(BRAND.textMuted)
      .text('No grid energy data available.', doc.page.margins.left, doc.y, { width: contentWidth });
    doc.moveDown(1);
    return;
  }

  renderTableRow(doc, ['Metric', 'Value'], { widths: colWidths, isHeader: true });

  const rows = [
    ['Total Generated', formatKwh(gridEnergy.totalGenerated)],
    ['Total Consumed', formatKwh(gridEnergy.totalConsumed)],
    ['Net Energy (Surplus / Deficit)', formatKwh(gridEnergy.netEnergy)],
    ['Total Readings', formatNumber(gridEnergy.readingCount)],
  ];

  rows.forEach((cols, i) => {
    renderTableRow(doc, cols, {
      widths: colWidths,
      isLast: i === rows.length - 1,
    });
  });

  doc.moveDown(1);
}

function renderTradingProfitTable(doc, gridTrading, personalProfit) {
  const { width } = doc.page;
  const contentWidth = width - doc.page.margins.left - doc.page.margins.right;
  const colWidths = [contentWidth * 0.55, contentWidth * 0.45];

  if (gridTrading) {
    renderSectionHeader(doc, 'Grid Trading Activity');

    renderTableRow(doc, ['Metric', 'Value'], { widths: colWidths, isHeader: true });

    const gridRows = [
      ['Completed Trades', formatNumber(gridTrading.completedTrades)],
      ['Total Energy Traded', formatKwh(gridTrading.totalEnergyTraded)],
      ['Total Volume (Credits)', formatNumber(gridTrading.totalVolumeCredits)],
      ['Active Listings', formatNumber(gridTrading.totalListings)],
      ['Cancelled Listings', formatNumber(gridTrading.cancelledListings)],
    ];

    gridRows.forEach((cols, i) => {
      renderTableRow(doc, cols, {
        widths: colWidths,
        isLast: i === gridRows.length - 1,
      });
    });

    doc.moveDown(1);
  }

  if (personalProfit) {
    ensureSpace(doc, 200);

    renderSectionHeader(doc, 'Personal Trading Profit');

    renderTableRow(doc, ['Metric', 'Value'], { widths: colWidths, isHeader: true });

    const profitRows = [
      ['Credits Received (Sales)', formatNumber(personalProfit.creditsReceived)],
      ['Credits Spent (Purchases)', formatNumber(personalProfit.creditsSpent)],
      ['Net Flow', formatNumber(personalProfit.netFlow)],
      ['Sale Count', formatNumber(personalProfit.saleCount)],
      ['Purchase Count', formatNumber(personalProfit.purchaseCount)],
    ];

    profitRows.forEach((cols, i) => {
      renderTableRow(doc, cols, {
        widths: colWidths,
        isLast: i === profitRows.length - 1,
      });
    });

    doc.moveDown(1);
  } else {
    ensureSpace(doc, 40);

    renderSectionHeader(doc, 'Personal Trading Profit');

    doc
      .font(FONTS.italic)
      .fontSize(10)
      .fillColor(BRAND.textMuted)
      .text(
        'No wallet connected. Connect a wallet to view personal trading profit.',
        doc.page.margins.left,
        doc.y,
        { width: contentWidth }
      );

    doc.moveDown(1);
  }
}

function renderNodeOverview(doc, nodeOverview) {
  const { width } = doc.page;
  const contentWidth = width - doc.page.margins.left - doc.page.margins.right;
  const colWidths = [contentWidth * 0.55, contentWidth * 0.45];

  renderSectionHeader(doc, 'Node Overview');

  if (!nodeOverview) {
    doc
      .font(FONTS.italic)
      .fontSize(10)
      .fillColor(BRAND.textMuted)
      .text('No node data available.', doc.page.margins.left, doc.y, { width: contentWidth });
    doc.moveDown(1);
    return;
  }

  renderTableRow(doc, ['Metric', 'Value'], { widths: colWidths, isHeader: true });

  const rows = [
    ['Total Nodes', formatNumber(nodeOverview.totalNodes)],
    ['Active Nodes', formatNumber(nodeOverview.activeNodes)],
  ];

  const byStatus = nodeOverview.byStatus || {};
  const statusKeys = Object.keys(byStatus).sort();
  for (const status of statusKeys) {
    rows.push([`  ${status}`, formatNumber(byStatus[status])]);
  }

  rows.push(['Inactive Nodes', formatNumber(nodeOverview.totalNodes - nodeOverview.activeNodes)]);

  rows.forEach((cols, i) => {
    renderTableRow(doc, cols, {
      widths: colWidths,
      isLast: i === rows.length - 1,
    });
  });

  doc.moveDown(1);
}

function renderForecastSection(doc, forecastOutlook) {
  if (!forecastOutlook) return;

  const { width } = doc.page;
  const contentWidth = width - doc.page.margins.left - doc.page.margins.right;
  const margin = doc.page.margins.left;
  const colWidths = [contentWidth * 0.55, contentWidth * 0.45];

  renderSectionHeader(doc, '7-Day Energy Forecast');

  if (forecastOutlook.summary) {
    doc
      .font(FONTS.regular)
      .fontSize(10)
      .fillColor(BRAND.textDark)
      .text(forecastOutlook.summary, margin, doc.y, { width: contentWidth, lineGap: 3 });

    doc.moveDown(0.6);
  }

  if (Array.isArray(forecastOutlook.forecasts) && forecastOutlook.forecasts.length > 0) {
    ensureSpace(doc, 30 + forecastOutlook.forecasts.length * 22);

    renderTableRow(doc, ['Date', 'Predicted (kWh)'], { widths: colWidths, isHeader: true });

    const rows = forecastOutlook.forecasts.map(f => {
      const label = f.date
        ? new Date(f.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : f.label || '\u2014';
      return [label, formatKwh(f.predicted ?? f.value)];
    });

    rows.forEach((cols, i) => {
      renderTableRow(doc, cols, {
        widths: colWidths,
        isLast: i === rows.length - 1,
      });
    });

    doc.moveDown(0.5);
  }

  if (forecastOutlook.disclaimer) {
    doc
      .font(FONTS.italic)
      .fontSize(8)
      .fillColor(BRAND.textMuted)
      .text(forecastOutlook.disclaimer, margin, doc.y, { width: contentWidth });
  }

  doc.moveDown(1);
}

function renderDisclaimerFooter(doc, isDemoData) {
  const range = doc.bufferedPageRange();

  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);

    const { width, height } = doc.page;
    const margin = doc.page.margins.left;
    const contentWidth = width - margin - doc.page.margins.right;
    const footerY = height - doc.page.margins.bottom + 12;

    doc
      .moveTo(margin, footerY - 4)
      .lineTo(margin + contentWidth, footerY - 4)
      .lineWidth(0.5)
      .strokeColor(BRAND.borderColor)
      .stroke();

    let text = 'EcoPulse Energy Report';
    if (isDemoData) {
      text += '  \u2022  Based on simulated demo data';
    }
    text += '  \u2022  Confidential';

    doc
      .font(FONTS.regular)
      .fontSize(7)
      .fillColor(BRAND.textMuted)
      .text(text, margin, footerY, { width: contentWidth, align: 'center' });
  }

  const lastPage = range.start + range.count - 1;
  doc.switchToPage(lastPage);
  doc.x = doc.page.margins.left;
  doc.y = doc.page.height - doc.page.margins.bottom;
}

module.exports = {
  renderCoverPage,
  renderExecutiveSummary,
  renderGridEnergyTable,
  renderTradingProfitTable,
  renderNodeOverview,
  renderForecastSection,
  renderDisclaimerFooter,
  PERIOD_LABELS,
};
