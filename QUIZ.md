# QUIZ: answer these ten questions without notes before discussing BeliefView

Answers are in `QUIZ_ANSWER_KEY.md`. Do not open it until you have answered aloud or in writing.
Anything you cannot answer is a feature or claim to remove from your presentation.

1. In one sentence each: what is the *state* of the Bayes filter, and what are the nine "motion modes"? What does the separate `outside` number mean?
2. The observer looks at a cell and does **not** detect the subject. Write the update for that cell's probability. Why does a cell hidden behind a rock barely change, and why does a foliage cell lose less than a clear cell?
3. Why must the filter be renormalised after a miss, and why is the outside state's miss likelihood exactly 1? What invariant do the tests check after every step?
4. What stops the filter from becoming falsely certain when the drone stares at one spot? (Name the rule, its parameter, and what the tests check.)
5. Explain the exit-rate assumption. What does the filter do with mass that crosses the boundary, and what does the exit-rate sweep (scenario D) measure?
6. Describe the greedy planner: how are candidate viewpoints generated, what is scored, what is the travel-time cost, and why is it "greedy, not globally optimal"?
7. Which baselines were used, what do they share with BeliefView, and what is the only thing allowed to differ? Why does the "no miss-update" ablation exist?
8. How do you know ground truth never reaches the filter or planner? Name two independent mechanisms (one structural, one test).
9. What does "reacquired" mean here, what is a censored search time, and why do we report the fraction reacquired by the deadline and restricted-mean search time instead of an average over successful runs only? What do the paired bootstrap intervals compare?
10. Name one model-mismatch failure you found in the results, and one thing this synthetic 2D simulation cannot tell you about a real drone.
