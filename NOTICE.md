# Third-party data, artwork and tooling attribution

Hero portraits, native hero icons, ability artwork and item artwork distributed
under `data/` belong to Valve Corporation. Dota 2 is a Valve trademark. The code
license does not grant rights to Valve artwork. This project is not affiliated
with or endorsed by Valve.

Imported Picker portraits retain the source bytes and Valve attribution recorded
in Picker's NOTICE.md at revision `1f890007a4112e3b5df453050565d0baad8772fa`.
Native images are decoded from game resources; the acquisition manifests retain
resource hashes and decoder identity. Source 2 Viewer is an external tool and
is not distributed in this package. Synthetic PNG test fixtures are generated
by the test code and do not contain Valve artwork.

The version-1 population parsers, position assignment, lane inference, synergy
and logistic fitting recipes derive from [dotabuff-picker](https://github.com/yarikleto/dotabuff-picker),
revision `1f890007a4112e3b5df453050565d0baad8772fa`. Their MIT license is retained
at [scripts/population/LICENSE-MIT](scripts/population/LICENSE-MIT). The library's
ISC license does not replace that notice.

The HTML excerpts in `tests/population/fixtures/` are Dotabuff material. The
`stratz-lane-outcome.json` fixture is STRATZ material. These fixtures retain the
original bytes and are included for parser verification. Provider data remains
the property of its respective owners; code licenses grant no additional data rights.
OpenDota supplies public match statistics. Hero identities and Dota 2 names belong
to Valve Corporation. This project is not affiliated with these providers.
