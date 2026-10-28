# Testmap UI Coverage Upload

Uploads the UI coverage reports produced by the Testmap rrweb plugins
(`@appsurify-testmap/rrweb-playwright-plugin`, `-cypress-plugin`, `-selenium-plugin`)
to your Testmap workspace. Every run of the action creates a new test run.

## Usage

```yaml
- run: npx playwright test
- name: Upload UI coverage to Testmap
  if: ${{ !cancelled() }}            # upload even when tests fail
  uses: appsurify/testmap-upload-action@v1
  with:
    url: https://acme.testmap.cloud  # your workspace
    token: ${{ secrets.TESTMAP_TOKEN }}
    project: My Project              # exact, case-sensitive project name
```

Create the token in Testmap: avatar menu → **Personal Access Tokens**. Store it as a repository
secret named `TESTMAP_TOKEN`.

## Inputs

| Input | Required | Default | Notes |
|---|---|---|---|
| `url` | yes | | Workspace URL, `https://<name>.testmap.cloud`. HTTPS only. |
| `token` | yes | | Personal access token `tmap_…`. Empty token (fork PRs) skips the upload with a warning. |
| `project` | yes | | Project name, matched exactly. |
| `testrun-name` | no | `<workflow> #<run>(.<attempt>) (<branch>)` | Max 255 characters. |
| `path` | no | `test-results/{playwright,cypress,selenium}/ui` | Newline-separated folders or files. A folder with `ui-coverage-reports.zip` sends only the ZIP; otherwise its `*.json` files. |
| `if-no-files-found` | no | `warn` | `warn`, `error` or `ignore`. |
| `fail-on-error` | no | `true` | `false` turns upload and import errors into warnings. Invalid inputs always fail. |
| `timeout` | no | `600` | Seconds. The import is synchronous on the server. |

## Outputs

`testrun-id`, `project-id`, `testrun-url`, `testcases-imported`. The action also writes a job summary.

## Troubleshooting

- **"No Testmap reports found"**: the spec imports `test` from `@playwright/test` instead of the plugin,
  `--reporter=…` was passed on the CLI, Cypress ran with `cypress open`, or the Selenium driver was not
  wrapped with `attach()`.
- **`PROJECT_NOT_FOUND`**: the `project` input does not match the project name exactly.
- **401**: the token is wrong, expired or revoked.

## Development

No dependencies and no build step: the action runs `src/index.mjs` directly on the runner's Node 24.

```bash
npm test   # node --test, includes an end-to-end run against a local mock server
```

The `live` job in `.github/workflows/test.yml` expects real report fixtures in `tests/fixtures/`
(not committed yet) plus `TESTMAP_DEV_*` secret/variables.
