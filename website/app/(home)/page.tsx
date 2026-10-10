import type { CSSProperties } from 'react';

import type { Metadata } from 'next';

import Image from 'next/image';

import Link from 'next/link';

import { DownloadButtons } from '@/components/download-buttons';

import { ProductVideo } from '@/components/product-video';

import { SiteFooter } from '@/components/site-footer';

import { siteConfig } from '@/lib/site.config';

import logo from '@/public/fabricator-logo.png';



export const metadata: Metadata = {

  title: 'Fabricator — Build Rayfin apps by chatting',

  description: siteConfig.description,

};



const GRID_ROUTES = [

  { d: 'M 308 -80 L 308 168 L 476 168 L 476 640', dur: '9s', delay: '0s' },

  { d: 'M 812 -80 L 812 280 L 644 280 L 644 640', dur: '11s', delay: '2.5s' },

  { d: 'M 140 -80 L 140 112 L 420 112 L 420 392 L 700 392 L 700 640', dur: '15s', delay: '5s' },

  { d: 'M 980 -80 L 980 224 L 868 224 L 868 640', dur: '10s', delay: '7.5s' },

  { d: 'M 588 -80 L 588 336 L 252 336 L 252 640', dur: '13s', delay: '3.8s' },

] as const;



const steps = [

  {

    title: 'Describe it',

    text: 'Tell Fabricator what to change. The built-in GitHub Copilot agent edits the project and shows its work log, diffs and decisions as it goes.',

    href: '/docs/build/chat',

  },

  {

    title: 'Watch it run',

    text: 'Use the live preview while Copilot works, then point at the running app in Design mode to queue visual changes from the page itself.',

    href: '/docs/build/preview',

  },

  {

    title: 'Ship it',

    text: 'Deploy to a Microsoft Fabric workspace, share the app with your tenant, and use Advisor checks to find issues before people rely on it.',

    href: '/docs/ship/deploy',

  },

] as const;



const features = [

  {

    title: 'Chat to build',

    href: '/docs/build/chat',

    text: 'Describe a change, reference files or images, choose a Copilot model, and review the resulting work log and file diffs.',

  },

  {

    title: 'Live preview & Design mode',

    href: '/docs/build/design',

    text: 'See the app running in Fabricator and select elements in the preview to queue visual changes for Copilot.',

  },

  {

    title: 'One-click deploy & sharing',

    href: '/docs/ship/deploy',

    text: 'Publish the current app to a Fabric workspace, redeploy after changes, and share the deployed app with people in your tenant.',

  },

  {

    title: 'The Advisor',

    href: '/docs/ship/advisor',

    text: 'Run quick checks and a read-only Copilot review for security, data model, configuration, performance and accessibility findings.',

  },

  {

    title: 'Code, history & data model',

    href: '/docs/build/code-and-history',

    text: 'Browse files, inspect turn-by-turn changes, open the project in VS Code, and review data entities and relationships.',

  },

  {

    title: 'Team workspaces',

    href: '/docs/team',

    text: 'Keep team apps in a private GitHub repository with personal previews and a pipeline that publishes to Fabric.',

    badge: 'Experimental',

  },

] as const;



export default function HomePage() {

  return (

    <main className="relative flex flex-1 flex-col items-center overflow-x-hidden px-4 pb-12 pt-14 sm:px-6 sm:pb-16 sm:pt-20">

      <div

        aria-hidden

        className="pointer-events-none absolute inset-x-0 top-0 -z-20 h-[760px] overflow-hidden [mask-image:radial-gradient(ellipse_58%_62%_at_50%_0%,black,transparent)]"

      >

        <div className="fabricator-grid absolute inset-0 opacity-70" />

        <div className="fabricator-grid-charge absolute inset-0" />

        <div className="absolute left-1/2 top-0 h-[620px] w-[1120px] -translate-x-1/2">

          {GRID_ROUTES.map((route) => (

            <span

              key={route.d}

              className="fabricator-flow"

              style={

                {

                  offsetPath: `path('${route.d}')`,

                  '--fabricator-dur': route.dur,

                  '--fabricator-delay': route.delay,

                } as CSSProperties

              }

            />

          ))}

        </div>

      </div>

      <div

        aria-hidden

        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[620px] bg-[radial-gradient(ellipse_50%_100%_at_50%_0%,rgba(53,163,234,0.14),transparent)]"

      />



      <section className="flex w-full max-w-4xl min-w-0 flex-col items-center text-center">

        <Image

          src={logo}

          alt=""

          aria-hidden

          width={96}

          height={96}

          className="mb-5 size-16 drop-shadow-[0_2px_12px_rgba(0,0,0,0.35)] sm:size-20"

          priority

        />

        <p className="mb-3 rounded-full border border-fd-border bg-fd-card/70 px-3 py-1 text-xs font-medium text-fd-muted-foreground backdrop-blur">

          Desktop workbench for Rayfin apps

        </p>

        <h1 className="text-3xl font-bold tracking-tight text-fd-foreground sm:text-6xl sm:leading-[1.05]">
          <span className="sm:hidden">Build Rayfin apps<br />by chatting.</span>
          <span className="hidden sm:inline">Build Rayfin apps by chatting.</span>
        </h1>
        <p className="mt-5 w-full max-w-[22rem] text-sm leading-6 text-fd-muted-foreground sm:hidden">
          Fabricator is a desktop workbench<br />
          for Rayfin apps.<br />
          Describe what you want.<br />
          Watch GitHub Copilot build it.<br />
          See it running live.<br />
          Ship it to Microsoft Fabric.<br />
          All in one window, with the Copilot<br />
          account you already have.
        </p>
        <p className="mt-5 hidden max-w-3xl text-xl leading-8 text-fd-muted-foreground sm:block">
          Fabricator is a desktop workbench for Rayfin apps. Describe what you want, watch GitHub Copilot build it, see it running live, and ship it to Microsoft Fabric — all in one window, with the Copilot account you already have.
        </p>
        <div className="mt-8 w-full">

          <DownloadButtons releasesUrl={siteConfig.releasesUrl} />

        </div>

      </section>



      <ProductVideo />



      <section aria-labelledby="how-it-works" className="mt-16 w-full max-w-6xl sm:mt-20">

        <div className="mx-auto max-w-2xl text-center">

          <h2 id="how-it-works" className="text-2xl font-semibold tracking-tight text-fd-foreground sm:text-3xl">

            How it works

          </h2>

          <p className="mt-3 text-fd-muted-foreground">

            The build loop stays in one desktop window: chat, preview, deploy, then keep improving.

          </p>

        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-3">

          {steps.map((step, index) => (

            <Link

              key={step.title}

              href={step.href}

              className="group rounded-2xl border border-fd-border bg-fd-card/70 p-5 shadow-sm backdrop-blur transition-colors hover:border-fd-primary/50 hover:bg-fd-accent/50"

            >

              <span className="inline-flex size-9 items-center justify-center rounded-full bg-fd-primary/10 text-sm font-semibold text-fd-primary">

                {index + 1}

              </span>

              <h3 className="mt-4 text-lg font-semibold text-fd-foreground">{step.title}</h3>

              <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">{step.text}</p>

              <span className="mt-4 inline-flex text-sm font-medium text-fd-primary group-hover:underline">Read more →</span>

            </Link>

          ))}

        </div>

      </section>



      <section aria-labelledby="features" className="mt-16 w-full max-w-6xl sm:mt-20">

        <div className="mx-auto max-w-2xl text-center">

          <h2 id="features" className="text-2xl font-semibold tracking-tight text-fd-foreground sm:text-3xl">

            What Fabricator includes

          </h2>

          <p className="mt-3 text-fd-muted-foreground">

            Tools for the parts of a Rayfin app project you touch every day.

          </p>

        </div>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">

          {features.map((feature) => (

            <Link

              key={feature.title}

              href={feature.href}

              className="group flex min-h-44 flex-col rounded-2xl border border-fd-border bg-fd-card/70 p-5 shadow-sm backdrop-blur transition-colors hover:border-fd-primary/50 hover:bg-fd-accent/50"

            >

              <div className="flex items-start justify-between gap-3">

                <h3 className="text-lg font-semibold text-fd-foreground">{feature.title}</h3>

                {'badge' in feature ? (

                  <span className="rounded-full border border-fd-primary/30 bg-fd-primary/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-fd-primary">

                    {feature.badge}

                  </span>

                ) : null}

              </div>

              <p className="mt-3 grow text-sm leading-6 text-fd-muted-foreground">{feature.text}</p>

              <span className="mt-5 text-sm font-medium text-fd-primary group-hover:underline">Open docs →</span>

            </Link>

          ))}

        </div>

      </section>



      <section aria-labelledby="need-help" className="mt-16 w-full max-w-6xl sm:mt-20">

        <div className="rounded-2xl border border-fd-border bg-fd-card/70 p-5 shadow-sm backdrop-blur sm:flex sm:items-center sm:justify-between sm:gap-6 sm:p-6">

          <div>

            <h2 id="need-help" className="text-xl font-semibold text-fd-foreground">

              Need help?

            </h2>

            <p className="mt-1 text-sm text-fd-muted-foreground">

              Start with troubleshooting, check common questions, or report a Fabricator issue.

            </p>

          </div>

          <div className="mt-4 flex flex-wrap gap-3 sm:mt-0">

            <Link href="/docs/troubleshooting" className="rounded-lg border border-fd-border px-3 py-2 text-sm font-medium hover:bg-fd-accent">

              Troubleshooting

            </Link>

            <Link href="/docs/reference/faq" className="rounded-lg border border-fd-border px-3 py-2 text-sm font-medium hover:bg-fd-accent">

              FAQ

            </Link>

            <a

              href="https://github.com/spatney/rayfin-fabricator/issues/new/choose"

              className="rounded-lg border border-fd-border px-3 py-2 text-sm font-medium hover:bg-fd-accent"

            >

              Report an issue

            </a>

          </div>

        </div>

      </section>



      <div className="w-full max-w-6xl">

        <SiteFooter />

      </div>

    </main>

  );

}

