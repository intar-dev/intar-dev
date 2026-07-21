# Full solution

The written-out root causes and canonical repairs live in each fault's spoiler:

- [faults/01-web-down/description.md](faults/01-web-down/description.md)
- [faults/02-db-stuck/description.md](faults/02-db-stuck/description.md)
- [faults/03-db-unreachable/description.md](faults/03-db-unreachable/description.md)
- [faults/04-db-flaky/description.md](faults/04-db-flaky/description.md)

Mechanically: `./restore.sh all` applies every canonical fix; `./restore.sh clean`
removes the namespaces. (CI runs `solve.sh` = inject everything, restore everything.)
