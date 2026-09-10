import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  // Set these on the host when the public URL is known. For GitHub project
  // Pages, use ASTRO_SITE=https://incompl.github.io and ASTRO_BASE=/pudding.
  site: process.env.ASTRO_SITE || undefined,
  base: process.env.ASTRO_BASE || '/',
});
