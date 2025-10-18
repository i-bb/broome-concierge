# Testing the Broome Concierge Transfer Flow

## Why Phone Testing is Required

**IMPORTANT:** Warm transfers with live bridging **cannot be properly tested on Vapi's web interface**.

### The Problem with Web Testing

When you test on Vapi's web platform:
- There is no actual Twilio call leg for the guest
- The `guestCallSid` header is either missing or refers to a non-Twilio session
- When `warmTransfer` tries to move the guest into the conference, it fails silently
- Result: Only the front desk joins the conference (1 participant in Twilio logs)
- The `guestConferenceUpdate: null` in the response confirms the guest leg wasn't moved

### Test via Actual Phone Number

To properly test transfers, you **must** call the actual Vapi phone number assigned to your assistant:

1. **Find your assistant's phone number**:
   - Log into Vapi dashboard
   - Navigate to your assistant settings
   - Look for the assigned phone number

2. **Make a test call**:
   ```
   Dial: [Your Vapi Phone Number]
   Say: "I'd like to book a room for December 8 to December 10 for 2 guests"
   Wait for availability results
   Say: "Yes, please connect me"
   ```

3. **Monitor Render logs** while on the call:
   ```
   [Extract guest call SID] found valid call SID { callSid: 'CA...' }
   [Warm transfer webhook] received request { connectCall: 'bridge', ... }
   [Warm transfer] attempting to move guest into conference { guestCallSid: 'CA...', ... }
   [Warm transfer] successfully updated guest call to join conference { callSid: 'CA...', status: '...' }
   [Twilio join-conference] inbound request { ... }
   ```

4. **Check Twilio conference logs**:
   - Should show **2 participants** (guest + front desk)
   - Both call SIDs should be visible
   - Duration should reflect actual conversation time

## Expected Flow (Phone Test)

1. Guest calls Vapi phone number → Twilio creates call SID `CA123...`
2. Vapi forwards request to warmTransfer webhook with header `x-vapi-twilio-call-sid: CA123...`
3. Webhook extracts guest call SID successfully
4. Webhook creates conference `broome-{uuid}` and dials front desk into it
5. Webhook updates guest's Twilio call (CA123...) to join same conference
6. Both parties are now in the same Twilio conference
7. Vapi assistant exits, Twilio keeps connection alive

### Date Handling

The assistant will:
- Say dates as "December 8 to December 10" **without mentioning the year**
- Send full dates with year to front desk in warmTransfer SMS (e.g., "December 8, 2025 to December 10, 2025")
- Let the front desk confirm the complete dates with the guest during booking

This prevents any confusion from the LLM potentially stating an incorrect year while ensuring the front desk has accurate information.

## Expected Flow (Web Test) - Transfers Will Fail

1. User tests on Vapi web interface → No Twilio call SID
2. Vapi forwards request to warmTransfer webhook **without** `x-vapi-twilio-call-sid` header
3. Webhook logs: `[Extract guest call SID] no valid call SID found in headers`
4. Webhook creates conference and dials front desk
5. Webhook logs: `[Warm transfer] missing guestCallSid - guest will not join conference (likely web test)`
6. Only front desk is in conference → front desk hears silence → hangs up
7. Twilio shows 1 participant, conference ends immediately

## Troubleshooting

### Issue: "Customer ended the call" immediately after transfer

**Check Render logs for:**
```
[Extract guest call SID] no valid call SID found in headers
[Warm transfer] missing guestCallSid - guest will not join conference
```

**Cause:** Testing on web instead of phone

**Solution:** Call the actual Vapi phone number

### Issue: Front desk joins but guest hears nothing

**Check Render logs for:**
```
[Warm transfer] failed to move guest into conference
```

**Possible causes:**
- Invalid Twilio call SID
- Call already ended before transfer
- Twilio API error (check `errorCode` in logs)

### Issue: Neither party joins conference

**Check Render logs for:**
```
[Warm transfer webhook] received request { connectCall: null, ... }
```

**Cause:** LLM didn't send `connectCall: "bridge"` parameter

**Solution:** 
1. Verify assistant configuration is up to date: `npm run assistant:update`
2. Verify warmTransfer tool schema is updated: `npm run warm-transfer-tool:update`

## Quick Verification

After making changes:

```bash
# Update assistant configuration
npm run assistant:update

# Update warmTransfer tool
npm run warm-transfer-tool:update

# Verify changes deployed to Render
git status
git push origin main

# Wait 1-2 minutes for Render to redeploy

# Test via phone call (not web!)
```

## Monitoring

### Render Logs
Watch for the complete sequence:
1. `[Extract guest call SID] found valid call SID`
2. `[Warm transfer webhook] received request`
3. `[Warm transfer webhook] computed bridge decision { willBridge: true }`
4. `[Warm transfer] attempting to move guest into conference`
5. `[Warm transfer] successfully updated guest call to join conference`
6. `[Warm transfer webhook] result { bridgeNumber: '+18447121434', ... }`
7. `[Twilio join-conference] inbound request` (should appear twice: once for guest, once for front desk)

### Twilio Conference Logs
- Navigate to Twilio Console → Voice → Conferences
- Find conference with name `broome-{uuid}`
- **Participants: 2** (success) vs **Participants: 1** (failure)
- Both call SIDs should be visible in participant list

### Vapi Call Logs
- Check transcript shows both `warmTransfer` and `transferCall` completed
- Response from `warmTransfer` should include non-null `bridgeNumber`
- Call should not end immediately after "Connecting you with our front desk now"
