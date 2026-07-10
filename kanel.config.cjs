/**
 * Kanel config: generates one TypeScript model per table in src/db/models,
 * straight from the live database schema. Run after every migration:
 *   npm run db:types
 */
require('dotenv').config();

module.exports = {
  connection: process.env.DATABASE_URL,
  outputPath: './src/db/models',
  preDeleteOutputFolder: true,
  schemas: ['public'],
  enumStyle: 'type',
  importsExtension: '.js', // required by NodeNext module resolution
  postRenderHooks: [
    // verbatimModuleSyntax forbids `export default <type>`; rewrite to the
    // type-only default export form.
    (_path, lines) =>
      lines.map((line) => {
        const match = line.match(/^export default (\w+);$/);
        return match ? `export type { ${match[1]} as default };` : line;
      }),
  ],
};
