# Fixture generator

Produces the real plugin reports in `tests/fixtures/` that the `live` CI job uploads.

```bash
cd tests/fixture-generator
npm init -y && npm i -D @playwright/test @appsurify-testmap/rrweb-playwright-plugin
npx playwright install chromium
npx playwright test
cp -r test-results/playwright/ui/. ../fixtures/
```

Generated with `@playwright/test` 1.63.0 and `@appsurify-testmap/rrweb-playwright-plugin` 3.60.1-alpha.1.
Absolute spec paths in the JSON were rewritten to `/home/runner/work/app/app/...`.
