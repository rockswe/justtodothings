"use client"

import Link from "next/link"
import { useTheme } from "../../contexts/ThemeContext"

export default function TermsAndConditionsPage() {
  const { theme } = useTheme()

  return (
    <div className={`min-h-screen ${theme === "dark" ? "bg-[#1a1a1a] text-white" : "bg-white text-black"} font-mono`}>
      <header className="w-full p-4 flex justify-between items-start">
        <Link href="/" className="text-2xl">
          justtodothings
        </Link>
        <div className="space-y-2 text-right">
          <Link href="/login" className="block hover:underline">
            login
          </Link>
          <Link href="/signup" className="block hover:underline">
            sign up
          </Link>
          <Link href="/contact" className="block hover:underline">
            contact
          </Link>
        </div>
      </header>

      <main className="flex flex-col items-center justify-center px-4 py-12">
        <div className="w-full max-w-3xl space-y-8">
          <h1 className="text-4xl text-center mb-12">terms and conditions</h1>

          <div className="space-y-6 text-sm">
            <p>Last Updated: March 21, 2025</p>

            <p>
              Please read these Terms and Conditions ("Terms", "Terms and Conditions") carefully before using the
              justtodothings application (the "App") operated by justtodothings ("us", "we", or "our"). By accessing or
              using the App, you agree to be bound by these Terms. If you disagree with any part of the terms, then you
              may not access the App.
            </p>

            <div>
              <p className="font-bold">1. Acceptance of Terms</p>
              <p>
                By using the App, you affirm that you are at least 13 years old and agree to comply with and be legally
                bound by these Terms, as well as our Privacy Policy. Your use of the App constitutes your acceptance of
                these Terms.
              </p>
            </div>

            <div>
              <p className="font-bold">2. Changes to the Terms</p>
              <p>
                We reserve the right, at our sole discretion, to modify or replace these Terms at any time. We will
                provide notice of such changes by updating the "Last Updated" date at the top of these Terms. Continued
                use of the App after any such changes shall constitute your consent to such changes. It is your
                responsibility to review these Terms periodically.
              </p>
            </div>

            <div>
              <p className="font-bold">3. User Accounts and Security</p>
              <p>
                Account Creation: To access certain features of the App, you may be required to register for an account.
                You agree to provide accurate and complete information when creating your account.
              </p>
              <p>
                Security: You are responsible for maintaining the confidentiality of your account information, including
                your password. You agree to notify us immediately of any unauthorized use or breach of your account.
              </p>
              <p>Account Responsibility: All activities that occur under your account are your sole responsibility.</p>
            </div>

            <div>
              <p className="font-bold">4. Acceptable Use</p>
              <p>You agree that you will not use the App to:</p>
              <ul className="list-disc pl-6 space-y-1">
                <li>Engage in any unlawful, harmful, or fraudulent activities.</li>
                <li>Distribute or transmit any viruses, malware, or other harmful computer code.</li>
                <li>Interfere with or disrupt the integrity or performance of the App.</li>
                <li>Violate the rights of others, including intellectual property rights or privacy rights.</li>
              </ul>
            </div>

            <div>
              <p className="font-bold">5. Intellectual Property</p>
              <p>
                All content, trademarks, logos, and other intellectual property displayed on the App are the property of
                justtodothings or its licensors and are protected by applicable intellectual property laws. You agree
                not to reproduce, duplicate, copy, sell, or exploit any portion of the App without our express written
                permission.
              </p>
            </div>

            <div>
              <p className="font-bold">6. User Content</p>
              <p>Ownership: You retain ownership of any content you submit or create through the App.</p>
              <p>
                License: By submitting content, you grant us a worldwide, non-exclusive, royalty-free license to use,
                reproduce, modify, and display your content solely for the purpose of operating and improving the App.
              </p>
              <p>
                Responsibility: You are solely responsible for your content and the consequences of posting or
                publishing it.
              </p>
            </div>

            <div>
              <p className="font-bold">7. Termination</p>
              <p>
                We reserve the right to terminate or suspend your account and access to the App, without prior notice or
                liability, for any reason, including but not limited to violation of these Terms or any other behavior
                that we deem harmful to our users or the App.
              </p>
            </div>

            <div>
              <p className="font-bold">8. Disclaimer of Warranties</p>
              <p>
                The App is provided on an "AS IS" and "AS AVAILABLE" basis without warranties of any kind, either
                express or implied. We do not warrant that:
              </p>
              <ul className="list-disc pl-6 space-y-1">
                <li>The App will be uninterrupted, timely, secure, or error-free.</li>
                <li>Any defects in the App will be corrected.</li>
                <li>The results obtained from the use of the App will be accurate or reliable.</li>
              </ul>
            </div>

            <div>
              <p className="font-bold">9. Limitation of Liability</p>
              <p>
                In no event shall justtodothings, its affiliates, directors, employees, or agents be liable for any
                indirect, incidental, special, consequential, or punitive damages arising out of your use of or
                inability to use the App, even if advised of the possibility of such damages.
              </p>
            </div>

            <div>
              <p className="font-bold">10. Indemnification</p>
              <p>
                You agree to indemnify, defend, and hold harmless justtodothings and its affiliates from any claims,
                liabilities, damages, losses, and expenses (including reasonable attorneys' fees) arising out of or in
                any way connected with your access to or use of the App, or your violation of these Terms.
              </p>
            </div>

            <div>
              <p className="font-bold">11. Governing Law and Dispute Resolution</p>
              <p>
                These Terms shall be governed by and construed in accordance with the laws of the jurisdiction in which
                justtodothings operates, without regard to its conflict of law provisions. Any disputes arising out of
                these Terms shall be resolved exclusively through binding arbitration in accordance with the rules of
                the applicable arbitration body.
              </p>
            </div>

            <div>
              <p className="font-bold">12. Third-Party Links</p>
              <p>
                The App may contain links to third-party websites or services that are not owned or controlled by
                justtodothings. We assume no responsibility for the content, privacy policies, or practices of any
                third-party sites or services. Use of such links is at your own risk.
              </p>
            </div>

            <div>
              <p className="font-bold">13. Contact Us</p>
              <p>If you have any questions about these Terms and Conditions, please contact us at:</p>
              <p>Email: contact@justtodothings.com</p>
            </div>
          </div>
        </div>
      </main>

      <footer className={`w-full p-8 text-center text-sm ${theme === "dark" ? "text-white/60" : "text-black/60"}`}>
        &copy; {new Date().getFullYear()} justtodothings. All rights reserved.
      </footer>
    </div>
  )
}
