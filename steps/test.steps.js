import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { localStorageByOrigin, readSessionState } from '../session-state.js';

const { Given, When, Then } = createBdd();

Given("I inject session state from file", async ({ context, page }) => {
  // Throws if the file is missing or not in native storageState format, rather
  // than quietly injecting nothing and letting the scenario run logged out.
  const { cookies, origins, sessionStorage } = readSessionState();

  await context.addCookies(cookies);

  const byOrigin = localStorageByOrigin(origins);

  // addInitScript runs before any page script on every navigation, which is
  // required since localStorage/sessionStorage can only be set once the page
  // has landed on the owning origin. localStorage is applied per-origin to
  // match how Playwright itself restores storageState; sessionStorage was
  // captured as a flat map, so it is applied wherever the run lands.
  await page.addInitScript(
    ({ byOrigin, sessionStorage }) => {
      for (const [key, value] of Object.entries(byOrigin[window.location.origin] ?? {})) {
        window.localStorage.setItem(key, value);
      }
      for (const [key, value] of Object.entries(sessionStorage)) {
        window.sessionStorage.setItem(key, value);
      }
    },
    { byOrigin, sessionStorage },
  );
});

Given("I am on home page", async ({ page }) => {
  await page.goto('https://www.saucedemo.com/inventory.html');
  //await expect(page.locator("xpath=(//a[text()='My Account'])[position()=1]")).toBeVisible();
});


When("Home page has a title {string}", async ({page}, str) => {
  await expect(page).toHaveTitle(str);
});

When("I add following itms to the cart", async ({page}, dataTable) => {

  const items = dataTable.hashes();

  await expect(page.getByText('Products', { exact: true })).toBeVisible();

  for (const row of items) {
    const itemName = row.NAME;

    await page
      .locator('[data-test="inventory-item"]')
      .filter({ hasText: itemName })
      .getByRole('button', { name: 'Add to cart' })
      .click();
  }

  await expect(page.locator('#shopping_cart_container')).toHaveText(String(items.length));
});

When("I click on cart icon", async ({page}) => {
  await page.locator('[data-test="shopping-cart-link"]').click();
});

Then("Cart page is loaded", async ({page}) => {
  await page.waitForLoadState('networkidle');
  await expect(page).toHaveURL(/cart\.html/);
});

When("I click on checkout button on cart page", async ({page}) => {
  await page.getByRole('button', { name: 'Checkout' }).click();
});

Then("Checkout step page has text {string}", async ({page}, str) => {
  //TODO - implement
});

Then("Checkout step page is loaded", async ({page}) => {
  await page.waitForLoadState('networkidle');
  await expect(page).toHaveURL(/checkout-step-one\.html/);
});
