/**
 * Browser side of Knapsack.ui: connect the App's Whistle runtime to one Agent
 * Session's `/browser/*` transport so the Agent can discover and run its
 * live commands.
 */
export {
  connectBrowser,
  UiBrowserError,
  type BrowserConnection,
  type BrowserConnectionOptions,
} from "./ui/browser.js";
