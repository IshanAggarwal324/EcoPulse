const BRAND = {
  primary: '#0f766e',
  secondary: '#134e4a',
  accent: '#14b8a6',
  textDark: '#1e293b',
  textMuted: '#64748b',
  textLight: '#ffffff',
  bgLight: '#f0fdfa',
  borderColor: '#99f6e4',
};

const FONTS = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique',
  boldItalic: 'Helvetica-BoldOblique',
  mono: 'Courier',
};

const PAGE_DEFAULTS = {
  size: 'A4',
  margins: { top: 60, bottom: 60, left: 55, right: 55 },
  bufferPages: true,
  info: {
    Producer: 'EcoPulse',
    Creator: 'EcoPulse Report Engine',
  },
};

module.exports = { BRAND, FONTS, PAGE_DEFAULTS };
