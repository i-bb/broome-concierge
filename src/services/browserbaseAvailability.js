import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';

const BOOKING_URL =
  'https://thebroomenyc.book.pegsbe.com/search?locale=en&offerCode=&flow=tf';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const startOfDay = (date) => {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
};

const parseReferenceDate = () => {
  const raw = process.env.CONCIERGE_REFERENCE_DATE || '2025-10-16';
  const normalized = typeof raw === 'string' && raw.trim() ? raw.trim() : '2025-10-16';
  const parsed = new Date(`${normalized}T00:00:00Z`);

  if (Number.isNaN(parsed.getTime())) {
    return startOfDay(new Date('2025-10-16T00:00:00Z'));
  }

  return startOfDay(parsed);
};

const REFERENCE_DATE = parseReferenceDate();

const getReferenceToday = () => new Date(REFERENCE_DATE.getTime());

const alignToReferenceYear = (date, reference) => {
  const cloned = new Date(date.getTime());

  if (cloned.getFullYear() < reference.getFullYear()) {
    const monthDiff = cloned.getMonth() - reference.getMonth();
    const dayDiff = cloned.getDate() - reference.getDate();
    const targetYear = monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)
      ? reference.getFullYear() + 1
      : reference.getFullYear();
    cloned.setFullYear(targetYear);
  }

  return cloned;
};

const parseISODateStrict = (value, label) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${label} provided. Expected format YYYY-MM-DD.`);
  }
  return date;
};

const ensureFutureDates = (rawCheckIn, rawCheckOut) => {
  const originalCheckIn = parseISODateStrict(rawCheckIn, 'checkInDate');
  const originalCheckOut = parseISODateStrict(rawCheckOut, 'checkOutDate');

  const nights = Math.max(
    1,
    Math.round(
      (startOfDay(originalCheckOut).getTime() - startOfDay(originalCheckIn).getTime()) /
        MS_PER_DAY
    )
  );

  let adjustedCheckIn = alignToReferenceYear(originalCheckIn, getReferenceToday());
  const today = startOfDay(getReferenceToday());

  while (startOfDay(adjustedCheckIn) < today) {
    adjustedCheckIn.setFullYear(adjustedCheckIn.getFullYear() + 1);
  }

  const adjustedCheckOut = new Date(adjustedCheckIn.getTime());
  adjustedCheckOut.setDate(adjustedCheckOut.getDate() + nights);

  const toISO = (date) => date.toISOString().slice(0, 10);

  return {
    checkInDate: adjustedCheckIn,
    checkOutDate: adjustedCheckOut,
    checkInISO: toISO(adjustedCheckIn),
    checkOutISO: toISO(adjustedCheckOut),
    nights
  };
};

const formatLongDate = (date) =>
  new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  }).format(date);

const parseMoney = (value) => {
  if (!value || typeof value !== 'string') return null;
  const digits = value.replace(/[^0-9]/g, '');
  if (!digits) return null;
  const amount = parseInt(digits, 10);
  return Number.isNaN(amount) ? null : amount;
};

const formatUSD = (value) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
  }).format(value);

const BELOW_TWENTY = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen'
];

const TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety'
];

const THOUSANDS = ['', 'thousand', 'million', 'billion'];

const chunkToWords = (num) => {
  let words = '';

  if (num >= 100) {
    words += `${BELOW_TWENTY[Math.floor(num / 100)]} hundred`;
    num %= 100;
    if (num > 0) words += ' ';
  }

  if (num >= 20) {
    words += TENS[Math.floor(num / 10)];
    num %= 10;
    if (num > 0) words += `-${BELOW_TWENTY[num]}`;
  } else if (num > 0) {
    words += BELOW_TWENTY[num];
  }

  return words;
};

const numberToWords = (num) => {
  if (num === 0) return 'zero';

  let value = Math.floor(num);
  let words = '';
  let idx = 0;

  while (value > 0) {
    const chunk = value % 1000;
    if (chunk > 0) {
      const segment = `${chunkToWords(chunk)}${
        THOUSANDS[idx] ? ` ${THOUSANDS[idx]}` : ''
      }`;
      words = words ? `${segment} ${words}` : segment;
    }
    value = Math.floor(value / 1000);
    idx += 1;
  }

  return words;
};

const stripTrailingPeriod = (text) =>
  typeof text === 'string' ? text.replace(/\.+\s*$/, '') : text;

const normalizeRooms = (rooms = []) =>
  rooms.map((room) => {
    const nightlyValue = parseMoney(room.nightlyRate);
    const totalValue = parseMoney(room.totalRate);

    const nightlyRate = nightlyValue ? formatUSD(nightlyValue) : room.nightlyRate;
    const totalRate = totalValue ? formatUSD(totalValue) : room.totalRate;
    const nightlyRateSpoken = nightlyValue
      ? `${numberToWords(nightlyValue)} dollars`
      : room.nightlyRate;
    const totalRateSpoken = totalValue
      ? `${numberToWords(totalValue)} dollars`
      : room.totalRate;

    return {
      name: room.name,
      nightlyRate,
      nightlyRateValue: nightlyValue ?? null,
      nightlyRateSpoken,
      totalRate,
      totalRateValue: totalValue ?? null,
      totalRateSpoken,
      cancellation: room.cancellation,
      notes: room.notes
    };
  });

const buildConversationalSummary = (status, rooms, checkInDate, checkOutDate) => {
  const stayWindow = `${formatLongDate(checkInDate)} through ${formatLongDate(checkOutDate)}`;

  if (status === 'AVAILABLE' && rooms.length > 0) {
    const sentences = [`We have accommodations available from ${stayWindow}.`];

    rooms.forEach((room) => {
      let sentence = `${room.name} is ${room.nightlyRateSpoken} per night`;

      if (room.totalRateSpoken) {
        sentence += `, about ${room.totalRateSpoken} for the stay`;
      }

      sentence += '.';

      const detailPieces = [];
      if (room.notes) detailPieces.push(stripTrailingPeriod(room.notes));
      if (room.cancellation) detailPieces.push(stripTrailingPeriod(room.cancellation));

      if (detailPieces.length) {
        sentence += ` ${detailPieces.join('. ')}.`;
      }

      sentences.push(sentence.replace(/\.\./g, '.'));
    });

    return sentences.join(' ').replace(/\s+/g, ' ').trim();
  }

  return `I'm sorry—there isn't availability from ${stayWindow} at the moment. Let's look at alternate dates or adjust the stay to find a perfect fit.`;
};

const availabilitySchema = z.object({
  status: z.enum(['AVAILABLE', 'UNAVAILABLE']).default('UNAVAILABLE'),
  summary: z
    .string()
    .describe('Warm, conversational recap the concierge can speak verbatim, highlighting availability or sellout.'),
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

Use the exact ISO dates provided above (do not substitute another year) and submit the search. Wait for the availability results to finish loading before proceeding.`;

const buildExtractionInstruction = ({ checkInDate, checkOutDate, adults, children, rooms }) =>
  `After searching the Broome booking engine for:
  - Check-in ${checkInDate}
  - Check-out ${checkOutDate}
  - ${rooms} room(s) for ${adults} adult(s) and ${children} child(ren)

Review the availability grid.
If no accommodations are available, set status to "UNAVAILABLE" and explain which dates or categories are sold out in summary.
If accommodations are available, set status to "AVAILABLE" and list each bookable room or package with the displayed nightly rate (include currency symbol), any total stay price noted on the page, and key cancellation or inclusion details.
Summaries should reference the searched dates so the concierge can cite them back to the guest. Write the summary as one or two warm sentences (no bullet points) that weave in the exact stay dates formatted as "Month DD, YYYY" using the year supplied in the search (never a different year), and highlight notable inclusions naturally.`;

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
  rooms: roomCount = 1
}) => {
  if (!checkInDate || !checkOutDate) {
    throw new Error('checkInDate and checkOutDate are required in YYYY-MM-DD format.');
  }

  const env = ensureEnvironment();
  const adjustedDates = ensureFutureDates(checkInDate, checkOutDate);

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

    await page.act(
      buildSearchInstruction({
        checkInDate: adjustedDates.checkInISO,
        checkOutDate: adjustedDates.checkOutISO,
        adults,
        children,
        rooms: roomCount
      })
    );

    const availability = await page.extract({
      instruction: buildExtractionInstruction({
        checkInDate: adjustedDates.checkInISO,
        checkOutDate: adjustedDates.checkOutISO,
        adults,
        children,
        rooms: roomCount
      }),
      schema: availabilitySchema
    });

    const normalizedRooms = normalizeRooms(availability.rooms || []);
    const status = availability.status ?? (normalizedRooms.length > 0 ? 'AVAILABLE' : 'UNAVAILABLE');
    const summary = buildConversationalSummary(
      status,
      normalizedRooms,
      adjustedDates.checkInDate,
      adjustedDates.checkOutDate
    );

    return {
      status,
      summary,
      rooms: normalizedRooms,
      search: {
        checkInDate: adjustedDates.checkInISO,
        checkOutDate: adjustedDates.checkOutISO,
        nights: adjustedDates.nights,
        adults,
        children,
        rooms: roomCount
      },
      meta: {
        generatedAt: new Date().toISOString(),
        referenceDateISO: REFERENCE_DATE.toISOString(),
        ...(availability.summary ? { rawSummary: availability.summary } : {})
      }
    };
  } finally {
    await stagehand.close();
  }
};

export default fetchBroomeAvailability;
