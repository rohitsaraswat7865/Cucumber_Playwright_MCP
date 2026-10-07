Feature: TEST-XXX2

  Background:
    Given I inject session state from file
    And Load default page

  @TEST-XXX2
  Scenario: Test Automation - Project Data002
    When I click on "PIM" in left navigation panel
    Then Top bar header contains text "PIM"
    And I type "Buzz" in Search
    And I click on main menu "Buzz" listed in left navigation panel
    Then Top bar header contains text "Buzz"
    When I click on buttom with text "Most Liked Posts"
    Then In buzz post text area with text "What's on your mind?" is clickable
    #Then I get a green popup in left down corner of page with message - "Successfully Saved"
    And At least 1 people have upcoming anniversaries in current month
    When I click on user name in top Top bar header
    Then Dropdown with only these clicklable options is visible
      | NAME            |
      | About           |
      | Support         |
      | Change Password |
      | Logout          |
    When I click on "About" in dropdown
    Then Popup with header "About" is visible
    And Popup depicts version - "OrangeHRM OS 5.9"
    When I close the popup
    Then COnfirm popup is closed
