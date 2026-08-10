import { createServer } from 'node:http';
import handler from './api/index.js';

const PORT = process.env.PORT || 4000;

createServer(handler).listen(PORT, () => {
  console.log(`Amritsari Kulcha system running at http://localhost:${PORT}`);
  console.log(`  Customer:  http://localhost:${PORT}/b/alkapuri/1`);
  console.log(`  Staff login: http://localhost:${PORT}/login`);
  console.log('  Demo logins: kitchen_alkapuri / kitchen123 · reception_alkapuri / reception123 · owner / owner123');
});
