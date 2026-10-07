import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';

const { Given, When, Then } = createBdd();

function xpathLiteral(value) {
  if (!value.includes("'")) return `'${value}'`;
  const parts = value.split("'").map(part => `'${part}'`);
  return `concat(${parts.join(`, "'", `)})`;
}

const USER_MENU_LINKS = `//header//ul[contains(@class,'oxd-dropdown-menu')]//a[contains(@class,'oxd-userdropdown-link')]`;
const DIALOG = `//div[contains(@class,'oxd-dialog-container-default--inner')]`;

When('I click on {string} in left navigation panel', async ({ page }, str) => {
  await page
    .locator(
      `xpath=//nav[@aria-label='Sidepanel']//a[contains(@class,'oxd-main-menu-item')][.//span[text()='${str}']]`,
    )
    .click();
});

Then('Top bar header contains text {string}', async ({ page }, str) => {
  await expect(
    page.locator(
      `xpath=//span[contains(@class,'oxd-topbar-header-breadcrumb')]/h6[contains(.,'${str}')]`,
    ),
  ).toBeVisible();
});

Then('Left navigation panel contains following items', async ({ page }, table) => {
  for (const { NAME } of table.hashes()) {
    await expect(
      page.locator(
        `xpath=//nav[@aria-label='Sidepanel']//ul[contains(@class,'oxd-main-menu')]//a[contains(@class,'oxd-main-menu-item')][.//span[text()='${NAME}']]`,
      ),
    ).toBeVisible();
  }
});

When('I type {string} in Search', async ({ page }, str) => {
  await page
    .locator(`xpath=//nav[@aria-label='Sidepanel']//input[@placeholder='Search']`)
    .fill(str);
});

Then('Only {string} is visible in left navigation panel', async ({ page }, str) => {
  const items = page.locator(
    `xpath=//nav[@aria-label='Sidepanel']//ul[contains(@class,'oxd-main-menu')]//a[contains(@class,'oxd-main-menu-item')]`,
  );
  await expect(items).toHaveCount(1);
  await expect(
    page.locator(
      `xpath=//nav[@aria-label='Sidepanel']//ul[contains(@class,'oxd-main-menu')]//a[contains(@class,'oxd-main-menu-item')][.//span[text()=${xpathLiteral(str)}]]`,
    ),
  ).toBeVisible();
});

When('I click on main menu {string} in left navigation panel', async ({ page }, str) => {
  await page
    .locator(`xpath=//nav[@aria-label='Sidepanel']//input[@placeholder=${xpathLiteral(str)}]`)
    .click();
});

When('I delete text in placeholder search in Left navigation panel', async ({ page }) => {
  await page.locator(`xpath=//nav[@aria-label='Sidepanel']//input[@placeholder='Search']`).fill('');
});

When('I click on buttom with text {string}', async ({ page }, str) => {
  // Buzz filter buttons only render their label while active; inactive ones show just an icon.
  const iconByLabel = {
    'Most Recent Posts': 'bi-clock-history',
    'Most Liked Posts': 'bi-heart-fill',
    'Most Commented Posts': 'bi-chat-dots-fill',
  };
  const icon = iconByLabel[str];
  if (!icon) throw new Error(`No Buzz filter button known for "${str}"`);
  await page
    .locator(
      `xpath=//div[contains(@class,'orangehrm-post-filters')]//button[.//i[contains(@class,'${icon}')]]`,
    )
    .click();
});

Then('In buzz post text area with text {string} is clickable', async ({ page }, str) => {
  const textArea = page.locator(
    `xpath=//div[contains(@class,'oxd-buzz-post')]//textarea[@placeholder=${xpathLiteral(str)}]`,
  );
  await expect(textArea).toBeVisible();
  await expect(textArea).toBeEnabled();
});

When('I click on text {string}', async ({ page }, str) => {
  await page
    .locator(
      `xpath=//div[contains(@class,'oxd-buzz-post')]//textarea[@placeholder=${xpathLiteral(str)}]`,
    )
    .click();
});

When('I write {string} using keyboard actions', async ({ page }, str) => {
  await page.keyboard.type(str);
});

When('I click on post button in buzz post', async ({ page }) => {
  await page
    .locator(
      `xpath=//div[contains(@class,'oxd-buzz-post')]//button[@type='submit'][normalize-space(.)='Post']`,
    )
    .click();
});

Then(
  'I get a green popup in left down corner of page with message - {string}',
  async ({ page }, str) => {
    await expect(
      page.locator(
        `xpath=//div[contains(@class,'oxd-toast-container--bottom')]//div[contains(@class,'oxd-toast--success')]//p[contains(@class,'oxd-text--toast-message')][normalize-space(.)=${xpathLiteral(str)}]`,
      ),
    ).toBeVisible();
  },
);

When('I click on main menu {string} listed in left navigation panel', async ({ page }, str) => {
  await page
    .locator(
      `xpath=//nav[@aria-label='Sidepanel']//ul[contains(@class,'oxd-main-menu')]//a[contains(@class,'oxd-main-menu-item')][.//span[text()=${xpathLiteral(str)}]]`,
    )
    .click();
});

Then(
  'At least {int} people have upcoming anniversaries in current month',
  async ({ page }, count) => {
    // On narrow viewports the widget sits behind a tab and is not rendered until it is selected.
    const widget = page.locator(`xpath=//div[@class='orangehrm-buzz-anniversary']`);
    if (!(await widget.isVisible())) {
      await page
        .locator(
          `xpath=//a[contains(@class,'oxd-tab-segment')][normalize-space(.)='Upcoming Anniversaries']`,
        )
        .click();
    }

    const month = new Date().toLocaleString('en-US', { month: 'short' });
    const items = page.locator(
      `xpath=//div[contains(@class,'orangehrm-buzz-anniversary')]//div[contains(@class,'orangehrm-buzz-anniversary-item')][.//p[contains(@class,'orangehrm-buzz-anniversary-duration-date')][starts-with(normalize-space(.),${xpathLiteral(month)})]]`,
    );
    await expect.poll(() => items.count()).toBeGreaterThanOrEqual(count);
  },
);

When('I click on user name in top Top bar header', async ({ page }) => {
  await page
    .locator(
      `xpath=//header//li[contains(@class,'oxd-userdropdown')]//span[contains(@class,'oxd-userdropdown-tab')]`,
    )
    .click();
});

Then('Dropdown with only these clicklable options is visible', async ({ page }, table) => {
  const expected = table.hashes().map(({ NAME }) => NAME);
  const links = page.locator(`xpath=${USER_MENU_LINKS}`);
  await expect(links).toHaveCount(expected.length);
  for (const name of expected) {
    await expect(
      page.locator(`xpath=${USER_MENU_LINKS}[normalize-space(.)=${xpathLiteral(name)}]`),
    ).toBeAttached();
  }
});

When('I click on {string} in dropdown', async ({ page }, str) => {
  await page.locator(`xpath=${USER_MENU_LINKS}[normalize-space(.)=${xpathLiteral(str)}]`).click();
});

Then('Popup with header {string} is visible', async ({ page }, str) => {
  await expect(
    page.locator(
      `xpath=${DIALOG}//div[contains(@class,'orangehrm-modal-header')]/h6[normalize-space(.)=${xpathLiteral(str)}]`,
    ),
  ).toBeVisible();
});

Then('Popup depicts version - {string}', async ({ page }, str) => {
  await expect(
    page.locator(
      `xpath=${DIALOG}//div[contains(@class,'orangehrm-about')]/div[p[contains(@class,'orangehrm-about-title')][normalize-space(.)='Version:']]/following-sibling::div[1]/p[contains(@class,'orangehrm-about-text')][normalize-space(.)=${xpathLiteral(str)}]`,
    ),
  ).toBeVisible();
});

When('I close the popup', async ({ page }) => {
  await page.locator(`xpath=${DIALOG}//button[contains(@class,'oxd-dialog-close-button')]`).click();
});

Then('COnfirm popup is closed', async ({ page }) => {
  await expect(
    page.locator(`xpath=//div[contains(@class,'oxd-dialog-container-default')]`),
  ).toHaveCount(0);
});
