// Bank message templates for Parser.js. Data only — adding a format means
// adding an entry here, not writing code.
//
// Each template runs against normalized text (single-spaced, footers cut).
// Named groups: amount (required), cur, date, merchant, account, reference.
// `samples` are scrubbed/synthetic messages with the expected read; the test
// suite runs every sample automatically (tests/parser.test.js). Never commit
// real messages — this repo is public.
//
// Seed entries below were written from approximated public formats, not from
// collected samples. Replace or extend them as real (scrubbed) samples and
// Re-read telemetry come in.

var BANK_TEMPLATES = [
  {
    id: "hdfc_upi_sent_sms_v1",
    channel: "sms",
    direction: "Debit",
    pattern:
      /^Sent (?<cur>Rs\.?|INR) ?(?<amount>[\d,]+(?:\.\d{1,2})?) From HDFC Bank A\/C [xX*]*(?<account>\d{3,4}) To (?<merchant>.+?) On (?<date>\d{2}\/\d{2}\/\d{2,4}) Ref (?<reference>\d{8,})/i,
    samples: [
      {
        text: "Sent Rs.250.00 From HDFC Bank A/C *1234 To SWIGGY On 07/10/26 Ref 628012345678 Not You? Call 18002586161/SMS BLOCK UPI to 7308080808",
        receivedAt: "2026-10-07T13:00:00",
        expect: {
          amount: 250,
          currency: "INR",
          transaction_type: "Debit",
          transaction_date: "2026-10-07",
          merchant: "Swiggy",
          accountLast4: "1234",
          reference: "628012345678"
        }
      }
    ]
  },
  {
    id: "hdfc_cc_spent_sms_v1",
    channel: "sms",
    direction: "Debit",
    pattern:
      /^Spent (?<cur>Rs\.?|INR|USD|EUR|GBP|AED|SGD) ?(?<amount>[\d,]+(?:\.\d{1,2})?) On HDFC Bank Card [xX*]*(?<account>\d{4}) At (?<merchant>.+?) On (?<date>\d{4}-\d{2}-\d{2})/i,
    samples: [
      {
        text: "Spent Rs.899 On HDFC Bank Card 5678 At NETFLIX.COM On 2026-10-07:10:22:11 Not You? Call 18002586161/SMS BLOCK CC 5678 to 7308080808",
        receivedAt: "2026-10-07T13:00:00",
        expect: {
          amount: 899,
          currency: "INR",
          transaction_type: "Debit",
          transaction_date: "2026-10-07",
          merchant: "Netflix.com",
          accountLast4: "5678"
        }
      }
    ]
  },
  {
    id: "icici_cc_spent_sms_v1",
    channel: "sms",
    direction: "Debit",
    pattern:
      /^(?<cur>INR|Rs\.?|USD|EUR|GBP|AED|SGD) (?<amount>[\d,]+(?:\.\d{1,2})?) spent (?:using|on) ICICI Bank Card [xX*]*(?<account>\d{4}) on (?<date>\d{2}-[A-Za-z]{3}-\d{2,4}) (?:on|at) (?<merchant>[^.]+?)\. Avl Limit/i,
    samples: [
      {
        text: "INR 2,340.00 spent using ICICI Bank Card XX4321 on 07-Oct-26 on ZOMATO. Avl Limit: INR 1,23,456.00. If not you, call 1800 2662/SMS BLOCK 4321 to 9215676766",
        receivedAt: "2026-10-07T13:00:00",
        expect: {
          amount: 2340,
          currency: "INR",
          transaction_type: "Debit",
          transaction_date: "2026-10-07",
          merchant: "Zomato",
          accountLast4: "4321"
        }
      },
      {
        text: "USD 12.99 spent on ICICI Bank Card XX4321 on 05-Oct-26 at SPOTIFY. Avl Limit: INR 1,20,000.00",
        receivedAt: "2026-10-07T13:00:00",
        expect: {
          amount: 12.99,
          currency: "USD",
          transaction_type: "Debit",
          transaction_date: "2026-10-05",
          merchant: "Spotify",
          accountLast4: "4321"
        }
      }
    ]
  },
  {
    id: "icici_acct_upi_debit_sms_v1",
    channel: "sms",
    direction: "Debit",
    pattern:
      /^ICICI Bank Acct [xX*]*(?<account>\d{3,4}) debited for (?<cur>Rs\.?|INR) ?(?<amount>[\d,]+(?:\.\d{1,2})?) on (?<date>\d{2}-[A-Za-z]{3}-\d{2,4}); (?<merchant>.+?) credited\. UPI:(?<reference>\d{8,})/i,
    samples: [
      {
        text: "ICICI Bank Acct XX123 debited for Rs 1,499.00 on 07-Oct-26; AMAZON PAY credited. UPI:628112345678. Call 18002662 for dispute. SMS BLOCK 123 to 9215676766.",
        receivedAt: "2026-10-07T13:00:00",
        expect: {
          amount: 1499,
          currency: "INR",
          transaction_type: "Debit",
          transaction_date: "2026-10-07",
          merchant: "Amazon Pay",
          accountLast4: "123",
          reference: "628112345678"
        }
      }
    ]
  },
  {
    id: "axis_upi_debit_sms_v1",
    channel: "sms",
    direction: "Debit",
    pattern:
      /^(?<cur>INR|Rs\.?) ?(?<amount>[\d,]+(?:\.\d{1,2})?) debited A\/c no\. [xX*]*(?<account>\d{3,4}) (?<date>\d{2}-\d{2}-\d{2,4}) [\d:]+ UPI\/P2[AM]\/(?<reference>\d{8,})\/(?<merchant>[^\/]+?) Not you/i,
    samples: [
      {
        text: "INR 560.00 debited A/c no. XX9012 07-10-26 13:45:10 UPI/P2M/628212345678/BLINKIT Not you? SMS BLOCKUPI Cust ID to 919951860002 Axis Bank",
        receivedAt: "2026-10-07T14:00:00",
        expect: {
          amount: 560,
          currency: "INR",
          transaction_type: "Debit",
          transaction_date: "2026-10-07",
          merchant: "Blinkit",
          accountLast4: "9012",
          reference: "628212345678"
        }
      }
    ]
  },
  {
    id: "sbi_upi_debit_sms_v1",
    channel: "sms",
    direction: "Debit",
    pattern:
      /^Dear UPI user A\/C [xX*]*(?<account>\d{3,4}) debited by (?<amount>[\d,]+(?:\.\d{1,2})?) on date (?<date>\d{2}[A-Za-z]{3}\d{2,4}) trf to (?<merchant>.+?) Refno (?<reference>\d{8,})/i,
    samples: [
      {
        text: "Dear UPI user A/C X4567 debited by 120.0 on date 07Oct26 trf to UBER INDIA Refno 628312345678. If not u? call 1800111109. -SBI",
        receivedAt: "2026-10-07T13:00:00",
        expect: {
          amount: 120,
          currency: "INR",
          transaction_type: "Debit",
          transaction_date: "2026-10-07",
          merchant: "Uber India",
          accountLast4: "4567",
          reference: "628312345678"
        }
      }
    ]
  },
  {
    id: "hdfc_acct_credit_sms_v1",
    channel: "sms",
    direction: "Credit",
    pattern:
      /^(?<cur>Rs\.?|INR) ?(?<amount>[\d,]+(?:\.\d{1,2})?) credited to HDFC Bank A\/c [xX*]*(?<account>\d{3,4}) on (?<date>\d{2}-\d{2}-\d{2,4}) by (?<merchant>.+?)\. Avl bal/i,
    samples: [
      {
        text: "Rs.85,000.00 credited to HDFC Bank A/c XX1234 on 01-10-26 by NEFT from ACME CORP INDIA PVT LTD. Avl bal: Rs.1,02,345.67",
        receivedAt: "2026-10-01T13:00:00",
        expect: {
          amount: 85000,
          currency: "INR",
          transaction_type: "Credit",
          transaction_date: "2026-10-01",
          merchant: "Acme Corp India Pvt Ltd",
          accountLast4: "1234"
        }
      }
    ]
  }
];
