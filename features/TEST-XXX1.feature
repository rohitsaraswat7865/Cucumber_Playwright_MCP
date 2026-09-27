Feature: Tasks

  Background:
    Given I inject session state from file
    And Load default page

  @TEST-XXX1
  Scenario: Test Automation - Project Data
    When I click on "PIM" in left navigation panel
    Then Top bar header contains text "PIM"
    And Left navigation panel contains following items
      | NAME        |
      | Leave       |
      | Time        |
      | My Info     |
      | Performance |
      | Dashboard   |
      | Directory   |
      | Maintenance |
      | Claim       |
      | Buzz        |
    When I click on main menu "Search" in left navigation panel
    And I type "Info" in Search
    Then Only "My Info" is visible in left navigation panel
