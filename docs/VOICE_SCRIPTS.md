# Voice scripts: the 30 explainer and strategy videos, in order

Generated from the concepts (`backend/scripts/printVoiceScripts.ts`), so each line is exactly what the video says and what its figures show. Day 1 is the first video requested; one is requested a day.

## Settings for the explainers and strategy videos

- Voice: Jessica Anne Bogart - A VO Professional; now cloned! (female, chosen 2026-10-17)
- Model: Eleven v4
- The voice's own presets as ElevenLabs applied them (read from the downloaded file names): speed 1.12, stability 50%, similarity 89%
- Output format: MP3 44.1 kHz 128 kbps
- Auto-tag not pressed; the only tag is [pause] after each line (see below)

Keep the same settings if any day is re-recorded, so the videos sound like one voice.

## How to record

1. Paste the text for a day as it is, [pause] tags included.
2. Generate it once and download the MP3 (one click makes two takes; either works).
3. Name the file exactly as shown (for example `explain-01-copy-trading-risk.mp3`). The number is the day.
4. Give the folder to Claude Code. `npx tsx scripts/splitVoiceRecordings.ts <folder>` cuts each file into one part per beat at the pauses between lines and checks every cut against the words; a day it cannot cut with confidence is reported and left alone, and that day is re-recorded.

Each line is one beat, followed by a [pause] tag: this voice pauses inside a line about as long as between lines, so without the tag the cut is a guess. If a recording still will not cut (the split check reports FAIL), generate that video one line at a time and save the parts as <planId>-1.mp3 to -9.mp3 in assets/voice/ instead (explain-04, explain-17 and explain-20 were made that way on 2026-10-17).

## The order

| Day | File name | Video |
|---|---|---|
| 1 | `explain-01-copy-trading-risk.mp3` | Copying one trade to two accounts copies the loss too |
| 2 | `explain-02-consistency-rule.mp3` | The consistency rule: when your best day is too big |
| 3 | `strategy-01-orb-range-trigger.mp3` | Opening range breakout explained: the range and the trigger |
| 4 | `explain-03-moving-stops.mp3` | What moving your stop loss actually costs |
| 5 | `explain-04-time-of-day.mp3` | Your best and worst time of day to trade |
| 6 | `strategy-04-vwap-pullback.mp3` | VWAP pullback strategy explained |
| 7 | `explain-06-drawdown-vs-loss-limit.mp3` | Drawdown buffer vs daily loss limit on a funded account |
| 8 | `explain-07-one-day-carries-month.mp3` | When one trading day carries your whole month |
| 9 | `strategy-06-break-and-retest.mp3` | Break and retest strategy explained |
| 10 | `explain-08-edge-score.mp3` | One score for how you trade, and what drags it down |
| 11 | `explain-09-normal-trade-count.mp3` | How many trades a day is normal for you? |
| 12 | `strategy-09-demand-zone.mp3` | Supply and demand zones explained: the demand zone |
| 13 | `explain-10-weak-hour.mp3` | The one hour of the day that loses |
| 14 | `explain-11-weekday-results.mp3` | Which weekday is losing you money? |
| 15 | `strategy-02-orb-fake-breakout.mp3` | Opening range breakout: spotting the fake breakout |
| 16 | `explain-12-losing-setup.mp3` | A good win rate can hide a losing setup |
| 17 | `explain-13-profit-target.mp3` | How close is close to a prop firm profit target? |
| 18 | `strategy-05-vwap-chop.mp3` | When the VWAP pullback stops working |
| 19 | `explain-14-wins-and-losses.mp3` | Wins, losses and net: reading your monthly tally |
| 20 | `explain-15-multiple-accounts.mp3` | Trading two prop accounts: which one is behind? |
| 21 | `strategy-07-retest-stop-target.mp3` | Break and retest: where the stop and target go |
| 22 | `explain-16-payout-pace.mp3` | How far is your payout at your current pace? |
| 23 | `explain-17-trading-plan-rules.mp3` | Following your trading plan, rule by rule |
| 24 | `strategy-10-supply-zone-target.mp3` | Supply and demand: why the target is the next zone |
| 25 | `explain-18-near-the-target.mp3` | 98% of the target is not a pass |
| 26 | `explain-19-trailing-floor.mp3` | Trailing drawdown explained: how the floor moves |
| 27 | `strategy-03-orb-stop-placement.mp3` | Opening range breakout: where the stop goes |
| 28 | `explain-20-busy-days.mp3` | Do your busiest trading days help or hurt? |
| 29 | `explain-21-best-setup-and-window.mp3` | Finding your best setup and your best time |
| 30 | `strategy-08-failed-retest.mp3` | Break and retest: when the retest fails |

## Day 1: Copying one trade to two accounts copies the loss too

File name: `explain-01-copy-trading-risk.mp3`

```
Same trade, two accounts. Each lost $1,201. [pause]

The trade was 5 contracts. [pause]

But it was tagged oversized on both. [pause]

Copying one trade to two accounts copies the risk as well as the reward. [pause]

Each account has its own loss limit, so one loss can fit one account and break another. [pause]

The trap is sizing for the account with the most room, when the one with the least room sets the safe size. [pause]

Before copying a trade, check each account's buffer and today's loss limit. [pause]

Fillbook's calendar shows each red day. [pause]

Do you copy trades across accounts?
```

## Day 2: The consistency rule: when your best day is too big

File name: `explain-02-consistency-rule.mp3`

```
One day made 46% of the profit. [pause]

The firm's consistency cap is 40%. [pause]

So that day is over the cap. [pause]

A consistency rule caps how much of your total profit any single day is allowed to make. [pause]

Firms use it to tell steady trading apart from one big day that carried the account. [pause]

The trap is one huge day, because it can push that day over the cap even while the account is profitable. [pause]

Divide your best day by your total profit and compare it with your firm's cap. [pause]

Fillbook flags it in Account Health. [pause]

Is your best day too big?
```

## Day 3: Opening range breakout explained: the range and the trigger

File name: `strategy-01-orb-range-trigger.mp3`

```
The first 15 minutes set a line on the chart, so what happens when price leaves it? [pause]

The opening range is the high and the low of the first 15 minutes of the session. [pause]

A common trigger is a candle that closes outside the range, not just a wick that pokes through it. [pause]

One common stop goes at the middle of the range, and a wider one goes past the other side. [pause]

A common target is one or two times the risk, measured from the entry to the stop. [pause]

The trap is chasing a late entry far from the range, which turns the same stop into a much bigger risk. [pause]

Some traders also want volume above average on the breakout candle before they count it. [pause]

Tag every opening range trade, and after twenty of them your own numbers show whether it works for you. [pause]

Do you trade the first 15 minutes of the session?
```

## Day 4: What moving your stop loss actually costs

File name: `explain-03-moving-stops.mp3`

```
Four trades tagged moved stop. Lost $656. [pause]

That averages $164 a trade. [pause]

But 12 tagged good discipline made $828. [pause]

A stop loss is a decision you make before the trade, while you are still calm. [pause]

Moving it during the trade turns a planned loss into a bigger one you never sized for. [pause]

The trap is that each move feels like a one-off, until the tagged trades are added up. [pause]

Tag each trade where you moved the stop, then total that tag once a week. [pause]

Fillbook's Insights ranks tagged habits by cost. [pause]

Which habit tops your cost list?
```

## Day 5: Your best and worst time of day to trade

File name: `explain-04-time-of-day.mp3`

```
Open wins 71%. Late morning, only 24%. [pause]

Open: 106 trades made $2,968. [pause]

But late morning lost $1,406. [pause]

Markets move differently through the session, so the same setup can work at one hour and fail at another. [pause]

A good total can hide one hour that keeps giving back what the rest of the day made. [pause]

The trap is staying at the screen after the move is over and trading because nothing is happening. [pause]

Group a month of your trades by entry time and compare each hour's win rate and P&L. [pause]

Fillbook's Reports sort trades by time. [pause]

What time of day costs you?
```

## Day 6: VWAP pullback strategy explained

File name: `strategy-04-vwap-pullback.mp3`

```
On a trend day price pulled back to VWAP, then held. [pause]

VWAP is the average price of the day, and on a trend day price stays on one side of it. [pause]

Then price pulls back toward VWAP instead of running away from it. [pause]

A common trigger is a candle that dips through VWAP and closes back above it. [pause]

The stop commonly goes under the pullback's low, and the first target is the high before the pullback. [pause]

The trap is buying every touch, when on a day without a trend VWAP gets crossed again and again. [pause]

Some traders only take it when VWAP itself is sloping in the direction of the trend. [pause]

Tag VWAP trades on trend days and range days separately, and the two groups tell different stories. [pause]

Do you trade the first pullback to VWAP?
```

## Day 7: Drawdown buffer vs daily loss limit on a funded account

File name: `explain-06-drawdown-vs-loss-limit.mp3`

```
A funded 50K account. Only $690 left. [pause]

Its drawdown buffer is just $690. [pause]

But today's loss limit still shows $1,200. [pause]

A funded account has two limits: the room above the drawdown floor, and a daily loss limit that resets. [pause]

Whichever of the two is smaller is the one that actually limits how much you can lose today. [pause]

The trap is watching only the daily limit, which can still show room after the buffer is nearly gone. [pause]

Before the open, write down the buffer and today's loss limit, and treat the smaller one as your limit. [pause]

Fillbook's rules page shows both limits. [pause]

Which number do you watch first?
```

## Day 8: When one trading day carries your whole month

File name: `explain-07-one-day-carries-month.mp3`

```
One day made $1,788 of the month. [pause]

Four days, eight trades, $1,873. [pause]

But the worst day lost $139. [pause]

A month's total can come from many steady days, or almost entirely from one big day. [pause]

When one day carries the month, taking that single day away changes the whole picture. [pause]

The trap is expecting that day again, and sizing up the next days to chase it. [pause]

Subtract your best day from the month and see what the rest of your trading made. [pause]

Fillbook's calendar shows best and worst days. [pause]

Is one day carrying your month?
```

## Day 9: Break and retest strategy explained

File name: `strategy-06-break-and-retest.mp3`

```
A level rejected price 2 times, then broke, then got tested from the other side. [pause]

The setup starts with a level that turned price back more than once. [pause]

Then a full candle closes above the level, not just a wick through it. [pause]

Price comes back to the level from above and closes back above it, which is the retest. [pause]

The stop commonly goes just under the level, and the target is the next level above. [pause]

The trap is entering on the break itself, with no retest to measure the stop from. [pause]

Some traders want a long wick off the level on the retest candle before they count it. [pause]

Tag the entries you take on the break and on the retest, and compare them after a month. [pause]

After 2 rejections and a break, do you wait for the retest?
```

## Day 10: One score for how you trade, and what drags it down

File name: `explain-08-edge-score.mp3`

```
Edge Score: only 67. Developing. [pause]

Rule adherence scores 87. [pause]

But profitability scores only 59. [pause]

Profit is only one part of how you trade, next to consistency, risk control and following your rules. [pause]

A blended score shows whether those parts are in balance, or whether one is pulling the rest down. [pause]

The trap is working on the part that is already strong, because the weak one is less fun to look at. [pause]

Find the factor that scores lowest and make that one the focus for the next few weeks. [pause]

Fillbook gives one score for five factors. [pause]

Which factor drags your score down?
```

## Day 11: How many trades a day is normal for you?

File name: `explain-09-normal-trade-count.mp3`

```
Normal pace: 2.7 trades a day. [pause]

Last session: 6, after a losing streak. [pause]

But frequency was up 126%. [pause]

Your average number of trades a day is a normal pace you can actually measure. [pause]

A session far above that pace stands out, and it is worth a second look before the next one. [pause]

The trap is adding trades after a losing run to win it back, which is a possible sign of overtrading. [pause]

Pick a daily trade cap near your normal pace and stop for the day when you reach it. [pause]

Fillbook's Daily Brief flags overtrading versus baseline. [pause]

How many trades is your normal?
```

## Day 12: Supply and demand zones explained: the demand zone

File name: `strategy-09-demand-zone.mp3`

```
Price came back to the zone where the move started, then rose about 16 points. [pause]

A demand zone is commonly marked at the base of tight candles just before a sharp move up. [pause]

Later, price returns into the area where that move started. [pause]

A common trigger is a bullish candle that covers the whole previous candle, called an engulfing candle. [pause]

The stop commonly goes under the zone, and the target is the supply zone above. [pause]

The trap is drawing the zone so wide that the stop ends up too far away to size sensibly. [pause]

Some traders only trade the first return to a zone, not the fourth or fifth. [pause]

Tag whether each zone trade was a first return or a later one, and compare the results. [pause]

Back at the zone, do you trade the first return?
```

## Day 13: The one hour of the day that loses

File name: `explain-10-weak-hour.mp3`

```
One hour wins only 25%. [pause]

That is across 20 timed trades. [pause]

But overall, trades win 62%. [pause]

Your overall win rate is an average of hours that can perform very differently. [pause]

One weak hour can quietly give back what the good hours made. [pause]

The trap is that losses in the same hour feel random until you group them together. [pause]

Sort your trades by entry hour and look at the hour with the lowest win rate. [pause]

Fillbook's Insights flags the weak hour. [pause]

Which hour hurts you most?
```

## Day 14: Which weekday is losing you money?

File name: `explain-11-weekday-results.mp3`

```
Four days made money. Monday lost $57. [pause]

Monday: 5 trades, minus $57. [pause]

But Tuesday made $157 in 5 trades. [pause]

Each weekday brings different news, volume and routine, so results can differ by day. [pause]

A good weekly total can hide one day that keeps losing week after week. [pause]

The trap is never splitting results by weekday, so the pattern never shows up. [pause]

Total each weekday's P&L over a month and see whether one day stands apart. [pause]

Fillbook's Reports break results out by weekday. [pause]

Which weekday is your weak spot?
```

## Day 15: Opening range breakout: spotting the fake breakout

File name: `strategy-02-orb-fake-breakout.mp3`

```
Price broke out of the opening range, and 1 candle later it was back inside. [pause]

The setup starts the same way, with the high and the low of the first 15 minutes. [pause]

A candle closes above the range high, which is the usual trigger. [pause]

The very next candle closes back inside the range, so the break did not hold. [pause]

A stop decided before the entry ends this trade early, before price reaches the other side. [pause]

The trap is holding past the stop because it might break out again, which turns a small loss into a big one. [pause]

Some traders wait for a second close outside the range, or a retest of its edge, before they enter. [pause]

Tag the breakouts that failed, and your own count shows how often it happens to you. [pause]

1 candle later, does your breakout still hold?
```

## Day 16: A good win rate can hide a losing setup

File name: `explain-12-losing-setup.mp3`

```
One setup. Eight trades. Lost $422. [pause]

It won just 25% of them. [pause]

But all trades won 64%. [pause]

A setup is a trade you repeat, so grouping trades by setup shows what each one really does. [pause]

A strong overall win rate can sit on top of one setup that loses money on its own. [pause]

The trap is a setup you like, which keeps getting taken long after it stopped paying. [pause]

List each setup with its trade count, win rate and P&L, and start with the worst one. [pause]

Fillbook's Reports rank setups, worst first. [pause]

Which setup is costing you most?
```

## Day 17: How close is close to a prop firm profit target?

File name: `explain-13-profit-target.mp3`

```
$7,516 made toward a $9,000 target. [pause]

That is 84% of the way. [pause]

But $1,484 is still to go. [pause]

A profit target is the amount an account has to make before a payout or a pass. [pause]

The last part of a target is often the hardest, because every trade starts to feel decisive. [pause]

The trap is sizing up to close the gap faster, which can undo weeks of progress in one day. [pause]

Write down the amount left and your normal daily pace, and let the gap close at that pace. [pause]

Fillbook's readiness page tracks the gap. [pause]

How far along is your target?
```

## Day 18: When the VWAP pullback stops working

File name: `strategy-05-vwap-chop.mp3`

```
Price crossed VWAP 8 times, and there was not one trend to follow. [pause]

On a range day VWAP goes flat, and price has no side to stay on. [pause]

Each cross can look like a pullback about to hold, which is why it is easy to keep trying. [pause]

Each failed hold is a small stop, and together they add up over the day. [pause]

Before the first trade, check whether VWAP is sloping or flat. [pause]

The trap is trading the pattern without looking at the day, because it behaves differently on each. [pause]

Some traders cap their number of trades on days when VWAP stays flat. [pause]

Tag each day as trend or range, and your results by day type show where the setup works. [pause]

Is today 8 crosses of VWAP, or a trend?
```

## Day 19: Wins, losses and net: reading your monthly tally

File name: `explain-14-wins-and-losses.mp3`

```
24 wins, 14 losses. Net: $1,549. [pause]

38 trades, month to date. [pause]

But 14 trades still lost. [pause]

Wins, losses and net profit together show how a month was actually made. [pause]

Even a profitable month is full of losing trades, and that is normal. [pause]

The trap is trying to avoid every loss, which tends to cut winners short as well. [pause]

Compare the size of your average win with your average loss, not just how many of each you had. [pause]

Fillbook's overview tallies wins, losses, net. [pause]

What does your month tally?
```

## Day 20: Trading two prop accounts: which one is behind?

File name: `explain-15-multiple-accounts.mp3`

```
One account is 52% to target. [pause]

The other is only 13%. [pause]

But health reads 87 against 80. [pause]

Each prop account is its own race, with its own target, rules and progress. [pause]

An account can be further from its target and still be in better health than the other. [pause]

The trap is running one plan for both, when the same trade can suit one account and not the other. [pause]

Once a week, review each account's target progress and health on its own. [pause]

Fillbook shows every account at a glance. [pause]

Which of your accounts lags?
```

## Day 21: Break and retest: where the stop and target go

File name: `strategy-07-retest-stop-target.mp3`

```
Risk only 3 points, with 6 points to the target, on one break and retest. [pause]

The broken level is where both the stop and the idea of the trade live. [pause]

The stop commonly goes just under the level, because a close back under it means the retest failed. [pause]

The first target is the next place where price turned before. [pause]

Divide the distance to the target by the distance to the stop, and here it is about two to one. [pause]

The trap is a target far past the next level, which makes the ratio look good and rarely gets reached. [pause]

Some traders close part of the trade at the first level and move the stop on the rest. [pause]

Log the planned target and where you really exited, because the gap between them is worth reviewing. [pause]

Is your target about 2 times your risk?
```

## Day 22: How far is your payout at your current pace?

File name: `explain-16-payout-pace.mp3`

```
129 more days at $20 a day. [pause]

A projection at the current pace. [pause]

But it already logged 19 trading days. [pause]

Your average daily profit turns a target into time, so you can see roughly how long it will take. [pause]

A payout can need several rules met at once, like trading days, a target and consistency. [pause]

The trap is trying to shorten the timeline, which usually means trading bigger than your plan. [pause]

List every rule your firm needs for a payout and check where you stand on each one. [pause]

Fillbook's readiness page checks each rule. [pause]

How many days would your account show?
```

## Day 23: Following your trading plan, rule by rule

File name: `explain-17-trading-plan-rules.mp3`

```
92% on plan. But one rule slips. [pause]

Trading window: 85%, slipping. [pause]

But max trades per day: 90%. [pause]

A trading plan is a set of separate rules, like a trading window, a trade limit and a size limit. [pause]

An overall plan score can look high while one rule keeps slipping underneath it. [pause]

The trap is an average, because good marks on the easy rules cover for the hard one. [pause]

Score each rule against your trades on its own and fix the lowest one first. [pause]

Fillbook's Plan page scores each rule. [pause]

Which rule do you slip on?
```

## Day 24: Supply and demand: why the target is the next zone

File name: `strategy-10-supply-zone-target.mp3`

```
Only about 13 points from demand up to supply, so is that enough room? [pause]

A supply zone is commonly marked where a sharp move up stalled and turned back down. [pause]

The demand zone is the base that the rally started from. [pause]

The entry is the confirmation candle back at the demand zone. [pause]

The stop sits under the demand zone, and the target sits just before supply, where selling may come back. [pause]

The trap is expecting price to run straight through supply, which often gives the profit back. [pause]

When the room up to supply is small next to the stop, some traders skip the trade. [pause]

Log the distance to the stop and to the next zone before every trade, then review them. [pause]

With 13 points up to supply, do you take it?
```

## Day 25: 98% of the target is not a pass

File name: `explain-18-near-the-target.mp3`

```
10 green days. 98% of the target. [pause]

$2,940 made against a $3,000 target. [pause]

But the target still isn't reached. [pause]

An evaluation counts the target as reached or not, so almost there still means not yet. [pause]

Close to the line, one trade starts to feel like the whole evaluation. [pause]

The trap is one big final trade to finish it, which can turn a near pass into a step back. [pause]

Keep your usual size on the final days and let the target arrive at your normal pace. [pause]

Fillbook's dashboard shows the target progress. [pause]

Would you trade on day eleven?
```

## Day 26: Trailing drawdown explained: how the floor moves

File name: `explain-19-trailing-floor.mp3`

```
The floor is breached. $60 below. [pause]

Below it, most firms close the account. [pause]

Yet Account Health reads 45 of 100. [pause]

A trailing drawdown floor follows your peak balance up, and it never comes back down. [pause]

So after a big winning day the floor rises with it, and your room to lose can shrink. [pause]

The trap is watching the balance, which can be up while the distance to the floor is small. [pause]

Every morning, write down where the floor is and how far your balance sits above it. [pause]

Fillbook flags the breach on screen. [pause]

Would you spot this in time?
```

## Day 27: Opening range breakout: where the stop goes

File name: `strategy-03-orb-stop-placement.mp3`

```
One entry, two stops, and one risks 7.5 points while the other risks 12. [pause]

The entry is the candle that closes above the opening range high. [pause]

A tight stop at the middle of the range means a smaller risk, but normal back and forth can reach it. [pause]

A wide stop past the other side gives more room, but the same size now risks much more money. [pause]

The stop comes first, and the size follows, so the money at risk stays the same either way. [pause]

The trap is widening the stop and keeping the same size, which quietly makes the loss much bigger. [pause]

Your plan's dollar risk per trade decides the size for whichever stop you choose. [pause]

Log where the stop was on every trade, then compare tight and wide after a month. [pause]

Is your risk closer to 7.5 or to 12?
```

## Day 28: Do your busiest trading days help or hurt?

File name: `explain-20-busy-days.mp3`

```
Flagged overtrading days: 0% before, 17% now. [pause]

Baseline 0%. Recent 17%. [pause]

But the win rate fell too. [pause]

A day far above your normal trade count can be flagged as a possible overtrading day. [pause]

A rising share of flagged days says more than any single busy session. [pause]

The trap is that a busy day feels productive, even when the extra trades add risk. [pause]

Put the win rate of your flagged days next to your normal days and compare them. [pause]

Fillbook's Progress page tracks both over time. [pause]

Do your busiest days help or hurt?
```

## Day 29: Finding your best setup and your best time

File name: `explain-21-best-setup-and-window.mp3`

```
One setup: 48 trades, still 88% wins. [pause]

Strongest setup: Order Block Retest. [pause]

But the strongest window is Open. [pause]

An edge usually lives in a few setups, traded at certain times of the day. [pause]

A strong win rate over many trades tells you more than the same rate over a handful. [pause]

The trap is taking every pattern you see, which spreads attention away from what works. [pause]

Find the setup and time window with the most trades and the best results, and name them. [pause]

Fillbook's Your Edge page ranks both. [pause]

What is your strongest setup?
```

## Day 30: Break and retest: when the retest fails

File name: `strategy-08-failed-retest.mp3`

```
The retest failed, and price fell about 7 points back through the level. [pause]

It starts the same way, with a level that held twice and then a close above it. [pause]

Price comes back to the level, just as it does on a good retest. [pause]

This time the candle closes back below the level, so the retest did not hold. [pause]

A stop under the level, set in advance, ends the trade right at the fail. [pause]

The trap is calling it a deeper retest, which is how a small loss quietly grows. [pause]

Some traders only count it as failed on a full close under the level, not a quick dip. [pause]

Tag every failed retest, and your own fail rate tells you how the setup behaves for you. [pause]

If it fell 7 points, where was your stop?
```
