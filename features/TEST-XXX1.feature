Feature: TEST-XXX1

  Background:
    Given I inject session state from file
    And Load default page

  @TEST-XXX1
  Scenario: Test Automation - Project Data001
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
    When I delete text in placeholder search in Left navigation panel
    And I type "Buzz" in Search
    And I click on main menu "Buzz" listed in left navigation panel
    Then Top bar header contains text "Buzz"
    When I click on buttom with text "Most Liked Posts"
    Then In buzz post text area with text "What's on your mind?" is clickable
    When I click on text "What's on your mind?"
    And I write "All is well" using keyboard actions
    And I click on post button in buzz post
    Then I get a green popup in left down corner of page with message - "Successfully Saved"
    And At least 1 people have upcoming anniversaries in current month
