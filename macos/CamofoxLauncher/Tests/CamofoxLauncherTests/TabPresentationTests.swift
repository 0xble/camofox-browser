import XCTest
@testable import CamofoxLauncher

final class TabPresentationTests: XCTestCase {
    func testEmptyOrWhitespaceTabTitleUsesAccessibleFallback() {
        XCTAssertEqual(Tab(tabId: "one", title: nil, url: nil).displayTitle, "Untitled tab")
        XCTAssertEqual(Tab(tabId: "two", title: "  \n", url: nil).displayTitle, "Untitled tab")
    }

    func testNonemptyTabTitleIsPreserved() {
        XCTAssertEqual(Tab(tabId: "one", title: "Example Domain", url: nil).displayTitle, "Example Domain")
    }
}