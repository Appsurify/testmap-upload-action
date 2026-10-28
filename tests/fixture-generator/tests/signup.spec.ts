import { test, expect } from '@appsurify-testmap/rrweb-playwright-plugin';
test.describe('Signup', () => {
  test('creates an account', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Email').fill('qa@example.com');
    await page.getByLabel('Plan').selectOption('Team');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Thanks!')).toBeVisible();
  });
  test('opens about page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'About' }).click();
    await expect(page.getByRole('heading', { name: 'About' })).toBeVisible();
  });
});
