# Internal

What the DSL is built from rather than what a test is written with. Every
block of it sits beside the public type it serves; hover text shows its
names as `Internal.…`.

## Assertion

The evaluated result of `Expect`. You'll see this in hover text.

### Extends

- [`Node`](#node)\<`"assertion"`\>

### Type Parameters

#### Actual

`Actual`

#### Condition

`Condition`

#### Expected

`Expected`

#### DisplayOrConfig

`DisplayOrConfig`

### Properties

#### actual

> `readonly` **actual**: `Actual`

#### condition

> `readonly` **condition**: `Condition`

#### config

> `readonly` **config**: `DisplayOrConfig`

#### expected

> `readonly` **expected**: `Expected`

***

## MissingExpected

What `Expect<X, "=">` evaluates to: the expected value was omitted for a
condition that needs one. This is deliberately *not* a `Test`, so it is a
compile error inside `Given`, `Skip`, `Only`, `Configure` or a `Table`, is
obvious in hover text, and is reported by the runner as an authoring error.
(TypeScript cannot reject an omitted type argument at the use site, so the
mistake is surfaced in the result type instead.)

### Extends

- [`Node`](#node)\<`"error"`\>

### Type Parameters

#### Condition

`Condition`

### Properties

#### condition

> `readonly` **condition**: `Condition`

#### error

> `readonly` **error**: `"an expected value is required for this condition"`

***

## Modifier

Marker so the printer (and hover text) can identify DSL nodes by name.

### Extends

- [`Node`](#node)\<`"modifier"`\>

### Type Parameters

#### Kind

`Kind` *extends* `string`

#### T

`T`

#### Payload

`Payload`

### Properties

#### kind

> `readonly` **kind**: `Kind`

#### payload

> `readonly` **payload**: `Payload`

#### test

> `readonly` **test**: `T`

***

## ModuleMock

Marker so the printer (and hover text) can identify DSL nodes by name.

### Extends

- [`Node`](#node)\<`"mock"`\>

### Type Parameters

#### Path

`Path`

#### With

`With`

### Properties

#### path

> `readonly` **path**: `Path`

#### with

> `readonly` **with**: `With`

***

## Node

Marker so the printer (and hover text) can identify DSL nodes by name.

### Extended by

- [`SnapshotNode`](#snapshotnode)
- [`NothingNode`](#nothingnode)
- [`Assertion`](#assertion)
- [`MissingExpected`](#missingexpected)
- [`Sequence`](#sequence)
- [`ModuleMock`](#modulemock)
- [`TableNode`](#tablenode)
- [`Modifier`](#modifier)

### Type Parameters

#### Kind

`Kind` *extends* `string`

***

## NothingNode

Marker so the printer (and hover text) can identify DSL nodes by name.

### Extends

- [`Node`](#node)\<`"nothing"`\>

***

## Sequence

Marker so the printer (and hover text) can identify DSL nodes by name.

### Extends

- [`Node`](#node)\<`"sequence"`\>

### Type Parameters

#### Effects

`Effects`

#### Then

`Then`

### Properties

#### effects

> `readonly` **effects**: `Effects`

#### then

> `readonly` **then**: `Then`

***

## SnapshotNode

Marker so the printer (and hover text) can identify DSL nodes by name.

### Extends

- [`Node`](#node)\<`"snapshot"`\>

### Type Parameters

#### Name

`Name` *extends* `string`

### Properties

#### name

> `readonly` **name**: `Name`

***

## TableNode

Marker so the printer (and hover text) can identify DSL nodes by name.

### Extends

- [`Node`](#node)\<`"table"`\>

### Type Parameters

#### F

`F`

#### Rows

`Rows`

### Properties

#### fn

> `readonly` **fn**: `F`

#### rows

> `readonly` **rows**: `Rows`

***

## ThrowsMatcher

Object form of a `"throws"` expectation. All fields optional; all listed fields must match.

### Properties

#### instanceOf?

> `readonly` `optional` **instanceOf?**: [`ClassRef`](#classref)

#### matches?

> `readonly` `optional` **matches?**: `string`

#### message?

> `readonly` `optional` **message?**: `string`

#### name?

> `readonly` `optional` **name?**: `string`

***

## AnyCtor

> **AnyCtor** = (...`args`) => `any`

### Parameters

#### args

...`any`[]

### Returns

`any`

***

## AnyFn

> **AnyFn** = (...`args`) => `any`

### Parameters

#### args

...`any`[]

### Returns

`any`

***

## ApproxCondition

> **ApproxCondition** = readonly \[`"~="`, `number`\]

Approximate equality with an absolute tolerance: `["~=", 1e-9]`.

***

## ArgumentsOf

> **ArgumentsOf**\<`T`\> = [`Signatures`](#signatures)\<`T`\>\[`0`\]

The arguments any of a function's overloads takes.

### Type Parameters

#### T

`T`

***

## ArrayCondition

> **ArrayCondition** = `"includes"` \| `"excludes"` \| `"matches"` \| `"some"` \| `"every"` \| `"isEmpty"` \| `"isNotEmpty"`

Conditions valid on arrays and typed arrays.

***

## CalleeFor

> **CalleeFor**\<`Args`\> = \[\] *extends* `Args` ? () => `unknown` : [`AnyFn`](#anyfn)

What a callee must be for `Args`: omitting them, or passing `[]`, is only
allowed of a callee that has no required parameters.

### Type Parameters

#### Args

`Args`

***

## ClassRef

> **ClassRef** = [`AnyCtor`](#anyctor) \| `Error`

A class written as a value (`typeof RangeError`) or, for error classes, as a
type (`RangeError`). The printer resolves either spelling to the constructor.
For `"instanceOf"` on non-error classes the actual's own instance type is
also accepted: `Expect<Repo, "instanceOf", UserRepository>`.

***

## ConditionsFor

> **ConditionsFor**\<`T`\> = [`UniversalCondition`](#universalcondition) \| `T` *extends* `number` ? [`OrderingCondition`](#orderingcondition) \| [`ApproxCondition`](#approxcondition) \| [`NumberCondition`](#numbercondition) : `never` \| `T` *extends* `bigint` \| `Date` ? [`OrderingCondition`](#orderingcondition) : `never` \| `T` *extends* `string` ? [`OrderingCondition`](#orderingcondition) \| [`StringCondition`](#stringcondition) : `never` \| `T` *extends* readonly `unknown`[] \| `ArrayBufferView` ? [`ArrayCondition`](#arraycondition) : `never` \| `T` *extends* `ReadonlySet`\<`unknown`\> ? [`ArrayCondition`](#arraycondition) : `never` \| `T` *extends* `ReadonlyMap`\<`unknown`, `unknown`\> ? `"isEmpty"` \| `"isNotEmpty"` : `never` \| `T` *extends* `object` ? `T` *extends* readonly `unknown`[] \| [`AnyFn`](#anyfn) ? `never` : [`ObjectCondition`](#objectcondition) : `never`

All conditions applicable to a value of type `T`.

### Type Parameters

#### T

`T`

***

## Config

> **Config** = `Partial`\<\{ `cwd`: `string`; `display`: [`DisplayPage`](#displaypage); `displayMeta`: \{\[`key`: `string`\]: [`Literal`](#literal); \}; `environment`: `"node"` \| `"browser"`; `retries`: `number`; `timeout`: `number`; \}\>

***

## ConstructorFor

> **ConstructorFor**\<`Args`\> = \[\] *extends* `Args` ? () => `unknown` : [`AnyCtor`](#anyctor)

`CalleeFor`, for a class.

### Type Parameters

#### Args

`Args`

***

## DeepPartial

> **DeepPartial**\<`T`\> = `T` *extends* (...`args`) => `unknown` ? `T` : `T` *extends* readonly infer Element[] ? `Element`[] *extends* `T` ? readonly [`DeepPartial`](#deeppartial)\<`Element`\>[] : `{ [Index in keyof T]: DeepPartial<T[Index]> }` : `T` *extends* `object` ? `{ [K in keyof T]?: DeepPartial<T[K]> }` : `T`

Every key optional, at any depth — but a list stays a list. Mapping over a
tuple keeps it a tuple, so an expected list written for a tuple actual is
checked position by position, which is how `toMatchObject` compares them:
element-wise, same length, in order.

A plain array is written as `readonly DeepPartial<Element>[]` rather than
mapped over. The compiler defers an array of an alias but expands a mapped
array eagerly, and on a recursive type (a JSON value, say) that expansion
never bottoms out ("type instantiation is excessively deep"). The tuple test
is type-fest's: an array of the element type is assignable to a plain array
and never to a tuple, whatever its optional or rest elements. `readonly`
because this is only ever the type of an *expected* value, and a readonly
target accepts a readonly or a mutable literal alike.

A function is left as it is: a mapped type would keep its properties and
drop its call signature, so `{ onClick: () => void }` would accept anything.

### Type Parameters

#### T

`T`

***

## DisplayPage

> **DisplayPage** = `` `${string}.html` ``

The page is loaded relative to the test file.

***

## ElementOf

> **ElementOf**\<`T`\> = `T` *extends* readonly infer U[] ? `U` : `T` *extends* `ReadonlySet`\<infer U\> ? `U` : `T` *extends* `string` ? `string` : `T` *extends* `object` ? `U` : `never`

### Type Parameters

#### T

`T`

***

## Equatable

> **Equatable**\<`T`\> = `T` \| `T` *extends* `object` ? readonly `E`[] : `never`

Typed arrays may be compared against plain tuples/arrays of their element type,
so `Expect<Uint32Array, "=", [1, 2, 3]>` type-checks.

### Type Parameters

#### T

`T`

***

## ExpectedFor

> **ExpectedFor**\<`Actual`, `Condition`\> = `Condition` *extends* [`NullaryCondition`](#nullarycondition) ? [`Nothing`](API.md#nothing) : `Condition` *extends* `"="` \| `"!="` \| `"is"` \| `"isNot"` ? [`Equatable`](#equatable)\<`Actual`\> : `Condition` *extends* [`OrderingCondition`](#orderingcondition) ? `Actual` : `Condition` *extends* [`ApproxCondition`](#approxcondition) ? `number` : `Condition` *extends* `"includes"` \| `"excludes"` ? [`ElementOf`](#elementof)\<`Actual`\> : `Condition` *extends* `"startsWith"` \| `"endsWith"` ? `string` : `Condition` *extends* `"matches"` ? `Actual` *extends* `string` ? `string` : [`DeepPartial`](#deeppartial)\<`Actual`\> : `Condition` *extends* `"some"` \| `"every"` ? (`element`, `index`) => `boolean` : `Condition` *extends* `"satisfies"` ? (`actual`) => `boolean` : `Condition` *extends* `"instanceOf"` ? ... \| ... : ... *extends* ... ? ... : ...

Shape the expected value must have for a given (Actual, Condition) pair.

### Type Parameters

#### Actual

`Actual`

#### Condition

`Condition`

***

## FileFormat

> **FileFormat** = `"text"` \| `"bytes"` \| `"json"`

How a file's contents are decoded by `FromFile`.

***

## Literal

> **Literal** = `string` \| `number` \| `boolean` \| `bigint` \| `null` \| `undefined` \| [`AnyFn`](#anyfn) \| readonly [`Literal`](#literal)[] \| \{\[`key`: `string`\]: [`Literal`](#literal); \}

The set of JavaScript values that can be written as a TypeScript literal type.

***

## MethodsCallableWith

> **MethodsCallableWith**\<`T`, `Args`\> = `{ [K in keyof T]-?: T[K] extends CalleeFor<Args> ? K : never }`\[keyof `T`\] & `string`

### Type Parameters

#### T

`T`

#### Args

`Args`

***

## NullaryCondition

> **NullaryCondition** = `"truthy"` \| `"falsy"` \| `"defined"` \| `"undefined"` \| `"isEmpty"` \| `"isNotEmpty"` \| `"isNaN"` \| `"isInteger"` \| `"isFinite"`

Conditions that take no expected value.

***

## NumberCondition

> **NumberCondition** = `"isNaN"` \| `"isInteger"` \| `"isFinite"`

Conditions valid on numbers.

***

## ObjectCondition

> **ObjectCondition** = `"matches"` \| `"hasKey"` \| `"lacksKey"`

Conditions valid on plain objects.

***

## OrderingCondition

> **OrderingCondition** = `">"` \| `">="` \| `"<"` \| `"<="`

Ordering conditions; valid for numbers, bigints, strings and Dates.

***

## Phantom

> **Phantom**\<`T`\> = `T` & `never`

`T & never` is eagerly `never`, and `X | never` is `X`, so `X | Phantom<T>` is
exactly `X` — but it "uses" `T`, which keeps parameters that exist purely
for the printer (`Args`, `Path`, …) from tripping `noUnusedParameters`.

### Type Parameters

#### T

`T`

***

## ReturnFor

> **ReturnFor**\<`T`, `Args`\> = [`Signatures`](#signatures)\<`T`\> *extends* infer Signature ? `Signature` *extends* \[infer Params, infer Result\] ? `Args` *extends* `Params` ? `Result` : `never` : `never` : `never`

What the overload that accepts `Args` returns.

### Type Parameters

#### T

`T`

#### Args

`Args`

***

## Row

> **Row**\<`F`\> = readonly \[`Parameters`\<`F`\>, `Awaited`\<`ReturnType`\<`F`\>\> \| [`Snapshot`](API.md#snapshot)\<`any`\>\] \| readonly \[`Parameters`\<`F`\>, [`ConditionsFor`](#conditionsfor)\<`Awaited`\<`ReturnType`\<`F`\>\>\>, [`ExpectedFor`](#expectedfor)\<`Awaited`\<`ReturnType`\<`F`\>\>, [`ConditionsFor`](#conditionsfor)\<`Awaited`\<`ReturnType`\<`F`\>\>\>\> \| [`Snapshot`](API.md#snapshot)\<`any`\>\]

A row of a `Table`: `[args, expected]` (implied `"="`) or `[args, condition, expected]`.

### Type Parameters

#### F

`F` *extends* [`AnyFn`](#anyfn)

***

## Signatures

> **Signatures**\<`T`\> = `T` *extends* \{(...`a`): `R1`; (...`a`): `R2`; (...`a`): `R3`; (...`a`): `R4`; \} ? \[`A1`, `R1`\] \| \[`A2`, `R2`\] \| \[`A3`, `R3`\] \| \[`A4`, `R4`\] : `T` *extends* \{(...`a`): `R1`; (...`a`): `R2`; (...`a`): `R3`; \} ? \[`A1`, `R1`\] \| \[`A2`, `R2`\] \| \[`A3`, `R3`\] : `T` *extends* \{(...`a`): `R1`; (...`a`): `R2`; \} ? \[`A1`, `R1`\] \| \[`A2`, `R2`\] : `T` *extends* (...`a`) => infer R ? \[`A`, `R`\] : `never`

Every call signature a function type has, as its parameters paired with what
it returns.

`Parameters<F>` and `ReturnType<F>` see only the *last* overload, so
`Invoke<typeof s.replace, [searchValue: ",", replaceValue: ";"]>` would be rejected for not being the
replacer-function form. Matching the overload list instead means any
spelling the function actually accepts is accepted here — up to four
overloads, which covers the standard library.

### Type Parameters

#### T

`T`

***

## StringCondition

> **StringCondition** = `"includes"` \| `"excludes"` \| `"startsWith"` \| `"endsWith"` \| `"matches"` \| `"isEmpty"` \| `"isNotEmpty"`

Conditions valid on strings.

***

## Test

> **Test** = [`Node`](#node)\<`"assertion"`\> \| [`Node`](#node)\<`"sequence"`\> \| [`Node`](#node)\<`"table"`\> \| [`Node`](#node)\<`"modifier"`\> \| readonly [`Test`](#test-1)[]

Anything that can be the right-hand side of an exported test alias.

***

## UniversalCondition

> **UniversalCondition** = `"="` \| `"!="` \| `"is"` \| `"isNot"` \| `"satisfies"` \| `"instanceOf"` \| `"truthy"` \| `"falsy"` \| `"defined"` \| `"undefined"` \| `"throws"`

Conditions that apply to any value.

***

## NT

> `const` **NT**: unique `symbol`
