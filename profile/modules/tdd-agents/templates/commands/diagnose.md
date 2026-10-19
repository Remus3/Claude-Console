---
description: Five-step debugging loop for something broken or behaving unexpectedly.
argument-hint: <the symptom>
---

# /diagnose

Symptom: $ARGUMENTS

1. Reproduce: find the shortest sequence that shows it every time. Write it down.
2. Minimise: remove everything that is not needed for the symptom to appear.
3. Hypothesise: list the candidate causes; for each, the observation that would
   rule it out. Test the cheapest first.
4. Fix: change one thing, for the cause that survived.
5. Verify: run the reproduction again, then the tests around it. If the symptom
   is still there, go back to 3 with what you learned.

Never change two things at once, and never report a fix the reproduction has not
confirmed.
