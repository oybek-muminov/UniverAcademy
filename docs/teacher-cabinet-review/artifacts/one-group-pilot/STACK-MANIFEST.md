> Public review copy: internal references were omitted. See the archive README for the current status.

# Single real Fizika group: offline stack and release gates


## Critical patch order

| Order | Private file | Verified blob |
| --- | --- | --- |
| 1 | `one-group-pilot-assignment.patch` | `013f7c4e12ae08c91917ee531f448bb922fceb31` |
| 2 | `ordinary-presentation.patch` | `a848c0be10ad4efda7a5de635ef778d2f77b559a` |
| 3 | `pilot-ordinary-numbers.patch` | `40e133423a75ddef15ca6825d357a8d9dc58fdee` |
| 4 | `one-group-worker-surface.patch` | `357e7031f4107ba717127d8b5fc6445e0ebffbab` |

Check from a clean pinned checkout with separate verified patch directory:
```bash
for name in one-group-pilot-assignment ordinary-presentation pilot-ordinary-numbers one-group-worker-surface; do
  git apply --check --whitespace=error "$PATCH_DIR/$name.patch" &&
    git apply --whitespace=error "$PATCH_DIR/$name.patch" || exit 1
done
```

Verified from the checkpoint's actual four blobs and the pinned base's four affected existing source blobs: strict forward apply together, Node v24 module syntax (JavaScript and stripped TS), strict reverse apply in reverse order, exact restored source blob hashes, and removal of the added file. No patch conflict in this core stack; syntax is not type, integration, IAM or live verification. These patches do not mount routes. Existing Worker registration, Student access and deletion behavior remain default.

**Keep out of this application:** multi-group, Public, invites/channel, bonus/Rasch, parallel consolidated/combined or older overlapping variants. Cabinet navigation and independent Teacher browser bootstrap are separate stacks; if later needed, use only the verified sequence bootstrap → browser pilot → browser Postgres, with proven metadata, permission and Clerk binding, not a second Clerk account. Do not apply the audience or early-close classifiers to the core: the first includes a deferred Public branch, and the second depends on explicit audience/authoritative locked original-cohort proof absent from core. Both are advisory/unmounted and may be reviewed separately on the singleton. The existing assignment code enforces next midnight in Asia/Tashkent and the Student personal deadline. Do not claim automatic early close works; if it is a launch criterion, require the reviewed narrow durable close transition first.

## Not a pilot release yet

- **Inventory:** No real group or version was found in the root's live inventory. Nothing can be pinned by substituting sample IDs, using “Fizika” as an ID, or treating an empty roster/catalog as ready. Obtain the actual approved subject ID and a real Teacher + designated registered Students; a real named group and its eligible roster, first real draft/demo/version, and only then the committed assignment ID. The known group-create/first-draft/Teacher initial-roster candidates have no reviewed persistent writer, and the existing Admin roster command must not be reused as Teacher. If a separately approved existing owner workflow cannot provision these objects, the writer gap is prior to routing.
- **Implementation:** exact reviewed dedicated staff Clerk + validator + scoped transaction/ACL composition, enforce locked staff version/demo/subject and assignment body triple and reauthorize before replay; exact Student admission/owned attempt group/demo/version pin inside lease and canonical locks; its ordinary projection only after commit. Worker classifier is not authorization. Named metadata and real browser coupling still need reviewed bindings where required.
- **Approvals separate from engineering:** owner to designate the real participants, subject, group name and real content and approve each necessary real provisioning workflow; technical approval of any dedicated binding/privileges and retention/deletion impact; separately authorized activation/verification destination, route allowlist and real-account exercise. No assumption of a role appointment, live SQL/DDL or production deployment.

**Next executable action:** stage the four-patch stack offline using the loop above. Once root has selected an authorized canonical provisioning path or reviewed writer for the missing real group/draft, obtain exact real pins and review the route-scoped composition against those pins. Only then plan the single designated Teacher edit/publish/assign and designated Student start/save/submit/own-result run. Keep rollout disabled meanwhile.
