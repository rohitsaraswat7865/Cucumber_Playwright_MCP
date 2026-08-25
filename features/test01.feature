Feature: Test site1

    Background:
        Given I inject session state from file
        And I am on home page

    Scenario: Check get started link0       
        When Home page has a title "Swag Labs"
        And I add following itms to the cart
        | NAME                |
        | Sauce Labs Backpack |
        | Sauce Labs Onesie   |
        When I click on cart icon
        Then Cart page is loaded
        When I click on checkout button on cart page
        Then Checkout step page is loaded
        And Checkout step page has text "Checkout: Your Information"


        
   