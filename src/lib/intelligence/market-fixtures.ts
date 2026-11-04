/** Short public-source excerpts, checked 2026-10-26. Fixtures only; never seeded as leads. */
export const publicMarketFixtures = [
  {
    title: "Airbus / AerCap order headline",
    url: "https://www.airbus.com/en/newsroom/press-releases/2026-03-aercap-places-order-for-100-additional-airbus-a320neo-family-aircraft",
    published: "2026-03-18",
    excerpt: "AerCap orders 100 additional Airbus A320neo Family aircraft",
    expected: {
      organization: "AerCap",
      aircraftFamily: "Airbus A320neo Family",
      quantity: 100,
      intent: "Fleet activity",
    },
  },
  {
    title: "Airbus / SMBC order headline",
    url: "https://www.airbus.com/en/newsroom/press-releases/2026-07-smbc-aviation-capital-orders-100-airbus-a320neo-family-aircraft",
    published: "2026-07-20",
    excerpt: "SMBC Aviation Capital orders 100 Airbus A320neo Family aircraft",
    expected: {
      organization: "SMBC Aviation Capital",
      aircraftFamily: "Airbus A320neo Family",
      quantity: 100,
      intent: "Fleet activity",
    },
  },
  {
    title: "Boeing / Norwegian headline: no quantity stated",
    url: "https://investors.boeing.com/investors/news/press-release-details/2025/Norwegian-Group-Places-New-Order-for-Boeing-737-MAX/default.aspx",
    published: "2025-09-26",
    excerpt: "Norwegian Group Places New Order for Boeing 737 MAX",
    expected: null,
  },
  {
    title: "Bombardier / NetJets: complex business aviation headline",
    url: "https://www.globenewswire.com/news-release/2024/05/01/2873094/0/en/Bombardier-Provides-Details-of-December-2023-Firm-Order-by-Customer-NetJets-for-12-Challenger-3500-Aircraft-and-232-Options.html",
    published: "2024-05-01",
    excerpt:
      "Bombardier Provides Details of December 2023 Firm Order by Customer NetJets for 12 Challenger 3500 Aircraft and 232 Options",
    expected: null,
  },
] as const;
