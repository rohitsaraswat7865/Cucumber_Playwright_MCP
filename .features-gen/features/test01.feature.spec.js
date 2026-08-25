// Generated from: features/test01.feature
import { test } from "playwright-bdd";

test.describe('Test site1', () => {

  test.beforeEach('Background', async ({ Given, And, context, page }, testInfo) => { if (testInfo.error) return;
    await Given('I inject session state from file', null, { context, page }); 
    await And('I am on home page', null, { page }); 
  });
  
  test('Check get started link0', async ({ When, Then, And, page }) => { 
    await When('Home page has a title "Swag Labs"', null, { page }); 
    await And('I add following itms to the cart', {"dataTable":{"rows":[{"cells":[{"value":"NAME"}]},{"cells":[{"value":"Sauce Labs Backpack"}]},{"cells":[{"value":"Sauce Labs Onesie"}]}]}}, { page }); 
    await When('I click on cart icon', null, { page }); 
    await Then('Cart page is loaded', null, { page }); 
    await When('I click on checkout button on cart page', null, { page }); 
    await Then('Checkout step page is loaded', null, { page }); 
    await And('Checkout step page has text "Checkout: Your Information"', null, { page }); 
  });

});

// == technical section ==

test.use({
  $test: [({}, use) => use(test), { scope: 'test', box: true }],
  $uri: [({}, use) => use('features/test01.feature'), { scope: 'test', box: true }],
  $bddFileData: [({}, use) => use(bddFileData), { scope: "test", box: true }],
});

const bddFileData = [ // bdd-data-start
  {"pwTestLine":11,"pickleLine":7,"tags":[],"steps":[{"pwStepLine":7,"gherkinStepLine":4,"keywordType":"Context","textWithKeyword":"Given I inject session state from file","isBg":true,"stepMatchArguments":[]},{"pwStepLine":8,"gherkinStepLine":5,"keywordType":"Context","textWithKeyword":"And I am on home page","isBg":true,"stepMatchArguments":[]},{"pwStepLine":12,"gherkinStepLine":8,"keywordType":"Action","textWithKeyword":"When Home page has a title \"Swag Labs\"","stepMatchArguments":[{"group":{"start":22,"value":"\"Swag Labs\"","children":[{"start":23,"value":"Swag Labs","children":[{}]},{"children":[{}]}]},"parameterTypeName":"string"}]},{"pwStepLine":13,"gherkinStepLine":9,"keywordType":"Action","textWithKeyword":"And I add following itms to the cart","stepMatchArguments":[]},{"pwStepLine":14,"gherkinStepLine":13,"keywordType":"Action","textWithKeyword":"When I click on cart icon","stepMatchArguments":[]},{"pwStepLine":15,"gherkinStepLine":14,"keywordType":"Outcome","textWithKeyword":"Then Cart page is loaded","stepMatchArguments":[]},{"pwStepLine":16,"gherkinStepLine":15,"keywordType":"Action","textWithKeyword":"When I click on checkout button on cart page","stepMatchArguments":[]},{"pwStepLine":17,"gherkinStepLine":16,"keywordType":"Outcome","textWithKeyword":"Then Checkout step page is loaded","stepMatchArguments":[]},{"pwStepLine":18,"gherkinStepLine":17,"keywordType":"Outcome","textWithKeyword":"And Checkout step page has text \"Checkout: Your Information\"","stepMatchArguments":[{"group":{"start":28,"value":"\"Checkout: Your Information\"","children":[{"start":29,"value":"Checkout: Your Information","children":[{}]},{"children":[{}]}]},"parameterTypeName":"string"}]}]},
]; // bdd-data-end