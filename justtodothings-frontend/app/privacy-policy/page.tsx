"use client"

import Link from "next/link"
import { useTheme } from "../../contexts/ThemeContext"

export default function PrivacyPolicyPage() {
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
          <h1 className="text-4xl text-center mb-12">privacy policy</h1>

          <div className="space-y-6 text-sm">
            <p>Last Updated: May 12, 2025</p>

            <p>
              This Privacy Policy describes how justtodothings ("we", "us", or "our") collects, uses, and shares your
              personal information when you use our application (the "App"). Please read this Privacy Policy carefully
              to understand our practices regarding your personal data.
            </p>

            <div>
              <p className="font-bold">1. Information We Collect</p>
              <p className="mb-2">
                We collect several types of information from and about users of our App, including:
              </p>
              <ul className="list-disc pl-6 space-y-1">
                <li>
                  <span className="font-semibold">Personal Information:</span> Email address, name, and other contact
                  information you provide when creating an account.
                </li>
                <li>
                  <span className="font-semibold">Usage Data:</span> Information about how you use the App, including
                  your tasks, preferences, and interaction patterns.
                </li>
                <li>
                  <span className="font-semibold">Connected App Data:</span> When you connect third-party applications
                  (Canvas LMS, Gmail, GitHub, Slack), we collect only the necessary data to provide the integration
                  functionality.
                </li>
                <li>
                  <span className="font-semibold">Device Information:</span> Information about your device, IP address,
                  browser type, and operating system.
                </li>
              </ul>
            </div>

            <div>
              <p className="font-bold">2. How We Use Your Information</p>
              <p className="mb-2">We use the information we collect to:</p>
              <ul className="list-disc pl-6 space-y-1">
                <li>Provide, maintain, and improve the App</li>
                <li>Process and complete transactions</li>
                <li>Send you technical notices, updates, and support messages</li>
                <li>Respond to your comments, questions, and requests</li>
                <li>Develop new products and services</li>
                <li>Detect, investigate, and prevent fraudulent transactions and other illegal activities</li>
                <li>Protect the rights and property of justtodothings and others</li>
              </ul>
            </div>

            <div>
              <p className="font-bold">3. Connected Apps and Third-Party Services</p>
              <p className="mb-2">
                When you connect third-party applications to justtodothings, we adhere to the following principles:
              </p>
              <ul className="list-disc pl-6 space-y-1">
                <li>
                  <span className="font-semibold">Canvas LMS:</span> We access your Canvas courses, assignments, and
                  deadlines to create tasks. We do not access or store your Canvas credentials directly; authentication
                  is handled through secure tokens.
                </li>
                <li>
                  <span className="font-semibold">Gmail:</span> We access your emails to extract task-related
                  information. We do not read or store the full content of your emails, only metadata and task-relevant
                  information.
                </li>
                <li>
                  <span className="font-semibold">GitHub:</span> We access your repositories, issues, and pull requests
                  to create tasks. We do not modify your code or repositories without explicit permission.
                </li>
                <li>
                  <span className="font-semibold">Slack:</span> We access your messages and channels to extract
                  task-related information. We do not read or store all messages, only those explicitly marked for task
                  creation.
                </li>
              </ul>
              <p className="mt-2">
                You can disconnect any third-party application at any time through the settings page. Upon
                disconnection, we will delete the access tokens and cease collecting data from that service.
              </p>
            </div>

            <div>
              <p className="font-bold">4. Data Security</p>
              <p>
                We implement appropriate technical and organizational measures to protect your personal information
                against unauthorized access, alteration, disclosure, or destruction. However, no method of transmission
                over the Internet or electronic storage is 100% secure, and we cannot guarantee absolute security.
              </p>
            </div>

            <div>
              <p className="font-bold">5. Data Retention</p>
              <p>
                We retain your personal information for as long as necessary to fulfill the purposes outlined in this
                Privacy Policy, unless a longer retention period is required or permitted by law. When you delete your
                account, we will delete or anonymize your personal information within 30 days.
              </p>
            </div>

            <div>
              <p className="font-bold">6. Your Rights</p>
              <p className="mb-2">Depending on your location, you may have the right to:</p>
              <ul className="list-disc pl-6 space-y-1">
                <li>Access the personal information we hold about you</li>
                <li>Correct inaccurate or incomplete information</li>
                <li>Delete your personal information</li>
                <li>Restrict or object to our processing of your personal information</li>
                <li>Data portability (receiving your data in a structured, commonly used format)</li>
                <li>Withdraw consent at any time, where processing is based on consent</li>
              </ul>
              <p className="mt-2">
                To exercise these rights, please contact us at{" "}
                <a href="mailto:contact@justtodothings.com" className="underline">
                  contact@justtodothings.com
                </a>
                .
              </p>
            </div>

            <div>
              <p className="font-bold">7. Children's Privacy</p>
              <p>
                Our App is not intended for children under 13 years of age. We do not knowingly collect personal
                information from children under 13. If you are a parent or guardian and believe your child has provided
                us with personal information, please contact us.
              </p>
            </div>

            <div>
              <p className="font-bold">8. Changes to This Privacy Policy</p>
              <p>
                We may update this Privacy Policy from time to time. We will notify you of any changes by posting the
                new Privacy Policy on this page and updating the "Last Updated" date. You are advised to review this
                Privacy Policy periodically for any changes.
              </p>
            </div>

            <div>
              <p className="font-bold">9. Contact Us</p>
              <p>
                If you have any questions about this Privacy Policy, please contact us at:{" "}
                <a href="mailto:contact@justtodothings.com" className="underline">
                  contact@justtodothings.com
                </a>
              </p>
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
