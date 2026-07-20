# Hint 4: Step 4 "cheating" doesn't get reverted?

Self-heal reacts to drift when ArgoCD notices it — a UI Refresh on the `demo` app forces
the comparison immediately. The ConfigMap snaps back to the git version. Now reverse the
experiment: which file would you edit to change the name *legitimately*?
