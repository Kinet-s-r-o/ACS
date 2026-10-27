# Product plan

## Provisioning variable math and statistics transformations

**Status:** Deferred; not implemented.

Extend Provisioning template Variables with safe numeric transformations and statistics for reuse in provisioning rules.

- Scalar math candidates: absolute value, round, floor, ceiling, minimum, maximum, addition, subtraction, multiplication, and division.
- Statistical candidates: mean, median, minimum, maximum, sum, and standard deviation over values from other Variables.
- Allow transformation operands to reference previously resolved Variables.
- Parse numeric inputs explicitly; return clear errors for non-numeric values, invalid operands, and division by zero.
- Use a restricted expression/operation implementation; never evaluate arbitrary code.
- Keep current string transformations and ordering behavior intact.

Revisit scope and operation names before implementation.
