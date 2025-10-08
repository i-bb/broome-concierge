import 'dotenv/config';
import express from 'express';
import fetchBroomeAvailability from './services/browserbaseAvailability.js';

const app = express();
app.use(express.json());

app.post('/browserbase/availability', async (req, res) => {
  try {
    const expectedSecret = process.env.BROWSERBASE_SERVER_SECRET;
    if (expectedSecret) {
      const authHeader = req.headers.authorization;
      if (authHeader !== `Bearer ${expectedSecret}`) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }
    }

    const {
      checkInDate,
      checkOutDate,
      adults = 2,
      children = 0,
      rooms = 1
    } = req.body || {};

    const result = await fetchBroomeAvailability({
      checkInDate,
      checkOutDate,
      adults: Number(adults) || 2,
      children: Number(children) || 0,
      rooms: Number(rooms) || 1
    });

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

const port = Number(process.env.PORT) || 8787;

if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`Browserbase availability server listening on ${port}`);
  });
}

export default app;
