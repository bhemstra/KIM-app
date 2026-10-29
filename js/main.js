// KIM-1: startpunt van index.html
import { KIM1, ROM_ENTRY } from './kim1.js';
import { SAMPLES } from './samples.js';
import { startApp } from './app.js';

const { TABLE, NMIT, IRQT, ...routines } = ROM_ENTRY;

startApp(new KIM1(), {
  name: 'KIM-1',
  storePrefix: 'kim1.',
  samples: SAMPLES,
  romNames: routines,
  resetLabel: 'RS',
});
