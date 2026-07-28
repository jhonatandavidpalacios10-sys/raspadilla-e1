const feedbackColors = ['sky', 'emerald', 'red', 'amber'];

export default {
  content: ['./index.html', './js/**/*.js'],
  safelist: [
    ...feedbackColors.flatMap((color) => [
      `border-${color}-500`,
      `border-${color}-500/30`,
      `bg-${color}-500/10`,
      `text-${color}-400`,
    ]),
    'border-sky-400',
    'border-amber-400',
  ],
  theme: {
    extend: {
      colors: {
        yape: '#8b5cf6',
        bcp: '#f97316',
        tarjeta: '#3b82f6',
      },
    },
  },
  plugins: [],
};
