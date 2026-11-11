# yocto-queue repository case

This pack contains two real defects from `sindresorhus/yocto-queue`.

The `tail-after-empty` production source, type declarations, readme and MIT license come from upstream tag `v1.2.1`, commit `ce72d41de87b2a4ec7c50e10480300bee674d845`. Its stale tail reference was fixed upstream in commit `8aead27` for issue `#14`.

The `drain-undefined` files come from upstream tag `v1.2.0`, commit `6f20a6fad9323285e9f7c04dd1232ccc5e931e7e`. Its drain iterator bug was fixed upstream in commit `ee91589` for issue `#13`.

The pack adds regression tests and independent hidden graders. It keeps the upstream API and dependency manifests. Dependency installation runs inside the required OS sandbox with network limited to `registry.npmjs.org`; install scripts are disabled.

Sources:

- https://github.com/sindresorhus/yocto-queue/tree/ce72d41de87b2a4ec7c50e10480300bee674d845
- https://github.com/sindresorhus/yocto-queue/issues/14
- https://github.com/sindresorhus/yocto-queue/commit/8aead27
- https://github.com/sindresorhus/yocto-queue/tree/6f20a6fad9323285e9f7c04dd1232ccc5e931e7e
- https://github.com/sindresorhus/yocto-queue/issues/13
- https://github.com/sindresorhus/yocto-queue/commit/ee91589
