/**
 * Real conversational speech, and specifically the twenty things the first
 * live run got wrong.
 *
 * The synthetic fixture in transcript.mjs is made of well-formed sentences,
 * because it was written. A real transcript is not: it is full of dependent
 * clauses that begin with "because", demonstratives with no antecedent, people
 * repeating themselves mid-sentence, and talk ABOUT the conversation rather
 * than in it. The first production run returned thirteen points containing
 * "because" and most of them could not stand alone.
 *
 * Every BAD line below is copied in shape from that run. Every GOOD line is a
 * real takeaway of the same subject matter. The test asserts the extractor
 * prefers the second kind — that is the whole point of this file.
 */
const S = (t, text) => ({ t, d: Math.max(4, Math.round(text.length / 16)), speaker: "", text });

/* Sentences that must NEVER be selected, each with the reason it fails. */
export const BAD = [
  "Because some people haven't quite figured out what their biggest goal is.",
  "Because I have, I always assume the best in people.",
  "Because, by the way, I started this research with over 100 questions.",
  "That is because selfless helpers, their entire story is about giving.",
  "It's actually just because you probably haven't learned the mechanics of conversation.",
  "This is why I'm asking because I want to, I want to, I'm coming from one perspective.",
  "We're talking because my brain went, got it, check, fifth grade teacher, got it.",
  "Please let's double click on this for a second because I think my planners, my planners.",
  "The reason why we'll often like we're processing, we're processing and then we're going.",
  "It's good because there's this wine bar across town that I'm really into.",
  "So that's the thing that I was saying to you earlier on in this episode.",
  "And I think that's, you know, kind of what we were getting at before.",
];

/* Sentences that SHOULD be selected — same speaker, same topic, but each one
   stands on its own without the sentence before it. */
export const GOOD = [
  "The single biggest predictor of whether a conversation continues is whether you ask a follow-up question within the first ninety seconds.",
  "People decide whether they trust you in about seven seconds, and almost all of that judgement comes from your hands and your eyebrows rather than your words.",
  "Ninety percent of small talk fails for one reason: both people are answering the question that was asked instead of the question underneath it.",
  "A conversation starter works when it gives the other person a choice of three doors, so replace how are you with what are you working on that you did not expect to enjoy.",
  "Introverts outperform extroverts in one-to-one negotiations by roughly twenty percent, and the mechanism is that they leave silences long enough for the other side to fill them.",
  "The mistake most people make in networking is optimising for how many rooms they enter rather than how many second conversations they earn.",
  "Rejection fear is misdiagnosed almost every time: what people actually fear is being boring, and those two problems have opposite solutions.",
  "You can change how warm you appear in a single gesture by keeping your palms visible, which raised trust ratings by thirty percent in our experiments.",
  "Write down the three questions you would want to be asked, and use those, because the questions you want are the questions your kind of person wants.",
  "The reason status games fail at dinner parties is that everyone is competing to be interesting and nobody is competing to be interested.",
  "We tested four thousand people and their biggest conversational fear was not rejection at all, it was running out of things to say.",
  "Charisma is two variables, warmth and competence, and almost everyone is unconsciously over-indexing on exactly one of them.",
];

/** A two-hour episode: the good lines spread through, buried in the bad. */
export function build() {
  const segs = [];
  let t = 0;
  segs.push(S(t += 5, "Welcome back to the show, it's good to have you here."));
  for (let i = 0; i < Math.max(BAD.length, GOOD.length); i++) {
    if (BAD[i]) segs.push(S(t += 55, BAD[i]));
    /* Filler between them, so the timeline is realistic and the spread logic
       has something to spread across. */
    segs.push(S(t += 40, "Yeah, exactly, and I think that's right, you know what I mean."));
    if (GOOD[i]) segs.push(S(t += 60, GOOD[i]));
    segs.push(S(t += 45, "Right, so let me ask you about something else entirely now."));
  }
  return segs;
}

export const TRANSCRIPT = (() => {
  const segments = build();
  return {
    provider: "fixture", language: "en", timestamped: true, segments,
    durationSec: segments[segments.length - 1].t + 20,
    chars: segments.reduce((n, s) => n + s.text.length, 0),
  };
})();
