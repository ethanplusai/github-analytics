#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(
    `GitHub Analytics needs Node 22.13 or newer (you have v${process.versions.node}).\n` +
    'Upgrade Node — https://nodejs.org — and run `npm start` again.',
  );
  process.exit(1);
}
await import('../server.js');
