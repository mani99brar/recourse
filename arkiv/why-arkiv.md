# Why Arkiv

The docket is a public record that other people read and that nobody, including us, should be able
to quietly edit. It needs three things a plain database does not give.

1. **A public read path with no trust in us.** Rates are only believable if a reader can fetch the
   rows themselves. Entities on Arkiv are queryable by anyone against a chain, so the page and any
   third party see the same rows.
2. **Writer identity.** Every entity has an owner that cannot be spoofed. Filtering on the scheme
   wallet's address is a statement of who published the record, and a competing publisher with the
   same schema name stays distinguishable.
3. **Typed, indexed queries instead of a file dump.** The page asks for "ruled cases for this shop
   this month" and gets a page of rows, not an export to parse. Indexed attributes make that cheap.

What Arkiv does not give us, and how the docket covers it:

- **No history.** The docket rebuilds its state from the contracts' logs and keeps its own journal,
  so Arkiv holds the published view, not the source of truth.
- **Bounded lifetime.** Entities expire. Rows are rewritten from the logs if they must outlive the
  window.
- **One shared writer.** The wallet that publishes the docket also receives unrefunded court-fee
  escrow. We state that overlap in the README rather than hide it.
