import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';

const BOOKING_URL =
  'https://thebroomenyc.book.pegsbe.com/search?locale=en&offerCode=&flow=tf';

const availabilitySchema = z.object({
  status: z.enum(['AVAILABLE', 'UNAVAILABLE']).default('UNAVAILABLE'),
  summary: z
    .string()
    .describe('Short natural language recap of what is available or sold out.'),
  rooms: z
    .array(
      z.object({
        name: z.string().describe('Room name as displayed on the site.'),
        nightlyRate: z
          .string()
          .optional()
          .describe('Nightly rate or starting rate including currency.'),
        totalRate: z
          .string()
          .optional()
          .describe('Total stay price if the site shows it, otherwise omit.'),
        cancellation: z
          .string()
          .optional()
          .describe('Key cancellation or deposit terms for the room/plan.'),
        notes: z
          .string()
          .optional()
          .describe('Any special inclusions, minimum stays or restrictions.')
      })
    )
    .default([])
});

const ensureEnvironment = () => {
  const {
    BROWSERBASE_API_KEY,
    BROWSERBASE_PROJECT_ID,
    OPENAI_API_KEY,
    STAGEHAND_MODEL
  } = process.env;

  if (!BROWSERBASE_API_KEY || !BROWSERBASE_PROJECT_ID) {
    throw new Error('Missing Browserbase credentials. Set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID.');
  }

  if (!OPENAI_API_KEY) {
    throw new Error('Missing OPENAI_API_KEY. Stagehand requires an LLM API key.');
  }

  return {
    apiKey: BROWSERBASE_API_KEY,
    projectId: BROWSERBASE_PROJECT_ID,
    modelName: STAGEHAND_MODEL || 'gpt-4o-mini',
    llmKey: OPENAI_API_KEY
  };
};

const buildSearchInstruction = ({ checkInDate, checkOutDate, adults, children, rooms }) =>
  `Load the Broome Hotel booking engine and update the search to:
  - Check-in: ${checkInDate}
  - Check-out: ${checkOutDate}
  - Rooms: ${rooms}
  - Adults: ${adults}
  - Children: ${children}

Submit the search and wait for the availability results to finish loading before proceeding.`;

const buildExtractionInstruction = ({ checkInDate, checkOutDate, adults, children, rooms }) =>
  `After searching the Broome booking engine for:
  - Check-in ${checkInDate}
  - Check-out ${checkOutDate}
  - ${rooms} room(s) for ${adults} adult(s) and ${children} child(ren)

Review the availability grid.
If no accommodations are available, set status to "UNAVAILABLE" and explain which dates or categories are sold out in summary.
If accommodations are available, set status to "AVAILABLE" and list each bookable room or package with the displayed nightly rate (include currency symbol), any total stay price noted on the page, and key cancellation or inclusion details.
Summaries should reference the searched dates so the concierge can cite them back to the guest.`;

/**
 * @typedef {Object} AvailabilityParams
 * @property {string} checkInDate - ISO date (YYYY-MM-DD)
 * @property {string} checkOutDate - ISO date (YYYY-MM-DD)
 * @property {number} [adults]
 * @property {number} [children]
 * @property {number} [rooms]
 */

/**
 * Queries Browserbase via Stagehand to capture Broome availability and rates.
 * @param {AvailabilityParams} params
 */
export const fetchBroomeAvailability = async ({
  checkInDate,
  checkOutDate,
  adults = 2,
  children = 0,
  rooms = 1
}) => {
  if (!checkInDate || !checkOutDate) {
    throw new Error('checkInDate and checkOutDate are required in YYYY-MM-DD format.');
  }

  const env = ensureEnvironment();

  const stagehand = new Stagehand({
    env: 'BROWSERBASE',
    apiKey: env.apiKey,
    projectId: env.projectId,
    modelName: env.modelName,
    modelClientOptions: {
      apiKey: env.llmKey
    }
  });

  await stagehand.init();

  try {
    const page = stagehand.page;
    await page.goto(BOOKING_URL, { waitUntil: 'networkidle' });

    await page.act(buildSearchInstruction({ checkInDate, checkOutDate, adults, children, rooms }));

    const availability = await page.extract({
      instruction: buildExtractionInstruction({ checkInDate, checkOutDate, adults, children, rooms }),
      schema: availabilitySchema
    });

    return {
      ...availability,
      search: {
        checkInDate,
        checkOutDate,
        adults,
        children,
        rooms
      }
    };
  } finally {
    await stagehand.close();
  }
};

export default fetchBroomeAvailability;
