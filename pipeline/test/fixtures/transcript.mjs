/**
 * A synthetic but realistic transcript: two speakers, sponsor break, a repeated
 * idea, banter, and six genuinely distinct claims. Written so that a correct
 * pipeline finds roughly six learnings and a padding one finds ten.
 */
const S = (t, speaker, text) => ({ t, d: Math.max(4, Math.round(text.length / 16)), speaker, text });

export const SEGMENTS = [
  S(0, "S0", "Welcome back to the show. You're listening to the podcast. Today my guest has run finance at three companies through two downturns."),
  S(14, "S1", "Thanks for having me. It's good to be here."),
  S(22, "S0", "Before we start — this episode is brought to you by Northline. Go to northline.com/show and use code SHOW for 20% off your first order. Terms and conditions apply."),
  S(46, "S0", "So let's start at the beginning. What did you get wrong early?"),
  S(58, "S1", "The thing I got wrong for about six years was treating the forecast as a prediction. It isn't. A forecast is a commitment device. The number's job is to make somebody change what they do on Monday, and if nobody changes anything when the number moves, you've built a very expensive weather report."),
  S(96, "S1", "I measure it now. If a forecast revision doesn't trigger at least one decision — hiring paused, a contract renegotiated, a launch moved — then that forecast is decoration and I should stop producing it."),
  S(128, "S0", "That's a strong claim. Does that survive contact with a board?"),
  S(140, "S1", "It survives better than the alternative. Boards don't punish uncertainty, they punish surprise. Two different things, and finance teams conflate them constantly. You can tell a board a number is plus or minus thirty percent and keep every ounce of credibility. What you cannot do is tell them plus or minus five and come back at thirty."),
  S(186, "S1", "The practical version: publish your error bars before you publish your number, and publish your hit rate every quarter. Nobody does it. The teams that do get given far more room."),
  S(220, "S0", "Let's talk about cost. Everyone's cutting."),
  S(232, "S1", "Most cost programmes fail because they cut spend instead of cutting commitments. Spend comes back. A commitment is a headcount plan, a three-year lease, a tooling contract with an auto-renewal. If you take ten percent out of discretionary spend and leave the commitment structure alone, you'll be back in the same room in nine months."),
  S(288, "S1", "The number I look at first isn't burn. It's what fraction of next year's cost base I could actually change if I decided to today. In a healthy company that's forty percent. I've seen it under fifteen."),
  S(330, "S0", "Under fifteen — what happens then?"),
  S(340, "S1", "Then you don't run the company, the contracts do. Every strategic option you have costs a penalty payment, so you stop considering them, and you start calling that discipline."),
  S(372, "S0", "Right. And on hiring finance people — what do you screen for?"),
  S(386, "S1", "I stopped screening for technical accuracy years ago. Everyone shortlisted can do the technical work. What separates people is whether they can say 'I don't know' with a plan attached. 'I don't know, here's what it would take to find out, here's what I'd assume in the meantime.' That sentence is the whole job."),
  S(438, "S1", "The interview question I use is deliberately unanswerable. I want to see the shape of the not-knowing, not the answer."),
  S(468, "S0", "Ha. Let's take a quick break. Like, comment and subscribe, and leave us a five-star review wherever you listen."),
  S(486, "S0", "We're back. You mentioned earlier that forecasts are commitment devices — say more."),
  S(500, "S1", "Same point really. A forecast that changes nobody's Monday is decoration. I said that already."),
  S(524, "S0", "Fair. What about the move abroad? You've hired across three markets."),
  S(538, "S1", "The mistake people make going to a new market is optimising the package before establishing the reference point. You don't know what your experience is worth there yet. In the Gulf the structure of the offer matters more than the headline — housing, schooling, the end-of-service calculation, whether the base is what the bonus multiplies against. Two offers with identical headlines can be thirty percent apart in cash."),
  S(602, "S1", "So the sequence is: get the range from three people who've actually moved, then negotiate structure, then negotiate the number. Reversed, you anchor yourself low and spend two years catching up."),
  S(650, "S0", "That's very concrete. And on the personal side — burnout, the hours?"),
  S(664, "S1", "I don't have a clever answer. I got it wrong for a long time and my kids remember that period, which is the only metric that matters to me now."),
  S(692, "S0", "That's a good place to stop. Thank you for coming on."),
  S(700, "S1", "Thanks for having me."),
];

export const TRANSCRIPT = {
  provider: "fixture", language: "en", timestamped: true,
  segments: SEGMENTS,
  durationSec: 712,
  chars: SEGMENTS.reduce((n, s) => n + s.text.length, 0),
};

export const EPISODE = {
  id: "fixture-abc123456789", sourceId: "fixture", show: "The Fixture Show",
  title: "What finance actually gets wrong — with a three-time CFO",
  url: "https://example.com/ep/1", type: "rss", ytId: "",
  audioUrl: "https://example.com/ep/1.mp3", guid: "fixture-1",
  publishedAt: new Date().toISOString(), durationSec: 712,
  description: "A conversation about forecasting, cost structure and hiring.",
  image: "", fixtureTranscript: SEGMENTS,
};
