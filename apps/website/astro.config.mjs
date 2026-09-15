import { defineConfig } from 'astro/config';
import { satteri } from '@astrojs/markdown-satteri';
import { naturalImageSize } from './plugins/natural-image-size.mjs';

export default defineConfig({
  output: 'static',
  // The live site is https://puddingisgood.com, served from the domain root, so
  // that is the default and canonical URLs are correct without any host
  // configuration. ASTRO_SITE / ASTRO_BASE still override it for a preview
  // deploy or a site served under a path.
  site: process.env.ASTRO_SITE || 'https://puddingisgood.com',
  base: process.env.ASTRO_BASE || '/',
  markdown: {
    processor: satteri({ hastPlugins: [naturalImageSize] }),
  },
});
