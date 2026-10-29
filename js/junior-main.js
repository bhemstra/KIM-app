// Junior Computer: startpunt van junior.html
import { Junior, ROM_ENTRY } from './junior.js';
import { SAMPLES_JUNIOR } from './samples-junior.js';
import { startApp } from './app.js';

const { LOOK, LEN, NMI, IRQ, ...routines } = ROM_ENTRY;

startApp(new Junior(), {
  name: 'Junior',
  storePrefix: 'junior.',
  samples: SAMPLES_JUNIOR,
  romNames: routines,
  resetLabel: 'RST',
});
